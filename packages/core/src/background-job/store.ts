export * as BackgroundJobStore from "./store"

import { and, desc, eq, gt, gte, isNull, lte, ne, or, sql } from "drizzle-orm"
import { Clock, Effect } from "effect"
import type { Database } from "../database/database"
import { Identifier } from "../id/id"
import { BackgroundJob } from "../background-job"
import { SessionSchema } from "../session/schema"
import { BackgroundJobTable, RuntimeFenceTable } from "./sql"

type DatabaseService = Database.Interface["db"]

/**
 * Bounded durable retention for settled output. The live registry keeps the
 * full output for the process lifetime; the row retains only the tail so a
 * crash cannot fill the database with megabytes of shell output per job.
 */
export const MAX_PERSISTED_OUTPUT_BYTES = 16_384

export const INTERRUPTED_ERROR = "Process exited while this job was running; its outcome is unknown."
export const STALE_OWNER_ERROR = "The previous job owner lost its lease; the job outcome is unknown."

/** A lease is also a fencing capability: runtime_id alone is never sufficient. */
export const LEASE_DURATION_MS = 30_000
export const HEARTBEAT_INTERVAL_MS = 10_000

/**
 * Fence time-to-live. A runtime's process-global fence is considered expired
 * when `now - heartbeat_at > FENCE_TTL_MS`. It matches the durable job lease
 * bound and is longer than the heartbeat interval so one missed heartbeat does
 * not expire the fence.
 */
export const FENCE_TTL_MS = 30_000

export type Lease = {
  readonly runtimeID: string
  readonly fence: number
}

export type Heartbeat =
  | { readonly renewed: true; readonly cancelRequested: boolean }
  | { readonly renewed: false; readonly cancelRequested: false }

export type CancelResult =
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "Settled"; readonly info: BackgroundJob.Info }
  | { readonly _tag: "Requested"; readonly info: BackgroundJob.Info }
  | { readonly _tag: "StaleOwner"; readonly info: BackgroundJob.Info }

/**
 * One ascending marker per process. It is only one component of ownership;
 * every write that can affect a running row also checks the monotonic fence
 * token and an unexpired lease. See specs/v2/background-jobs.md.
 */
let currentRuntime: string | undefined
export const runtimeID = () => currentRuntime ?? (currentRuntime = Identifier.ascending("runtime"))

const tail = (output: string) =>
  output.length <= MAX_PERSISTED_OUTPUT_BYTES ? output : `…${output.slice(-MAX_PERSISTED_OUTPUT_BYTES)}`

const fromRow = (row: typeof BackgroundJobTable.$inferSelect): BackgroundJob.Info => ({
  id: row.id,
  type: row.type,
  status: row.status,
  started_at: row.started_at,
  ...(row.title === null ? {} : { title: row.title }),
  ...(row.session_id === null ? {} : { session_id: row.session_id }),
  ...(row.completed_at === null ? {} : { completed_at: row.completed_at }),
  ...(row.output === null ? {} : { output: row.output }),
  ...(row.error === null ? {} : { error: row.error }),
  ...(row.metadata === null ? {} : { metadata: row.metadata }),
  ...(row.cancel_requested_at === null ? {} : { cancel_requested_at: row.cancel_requested_at }),
})

/**
 * Record launch and hand the caller the row's initial fencing capability.
 * Best-effort durability is preserved by callers: a missing return value means
 * that live work can continue, but it cannot claim a durable lease.
 */
export const insert = Effect.fn("BackgroundJobStore.insert")(function* (db: DatabaseService, info: BackgroundJob.Info) {
  const now = yield* Clock.currentTimeMillis
  const row = yield* db
    .insert(BackgroundJobTable)
    .values({
      id: info.id,
      type: info.type,
      title: info.title ?? null,
      session_id: (info.metadata?.sessionID as SessionSchema.ID | undefined) ?? null,
      status: info.status,
      runtime_id: runtimeID(),
      started_at: info.started_at,
      metadata: info.metadata ?? null,
      fence: 1,
      heartbeat_at: now,
      lease_until: Math.max(now, info.started_at) + LEASE_DURATION_MS,
    })
    .onConflictDoNothing()
    .returning({ runtimeID: BackgroundJobTable.runtime_id, fence: BackgroundJobTable.fence })
    .get()
    .pipe(Effect.orDie)
  return row === undefined ? undefined : ({ runtimeID: row.runtimeID, fence: row.fence } satisfies Lease)
})

/**
 * Record settlement only while the caller still owns the row. A false result
 * is a deliberate stale-owner rejection, not a transient persistence failure;
 * the old owner must not deliver a second completion after another runtime has
 * fenced it. A durable lease is required even when persistence is best-effort:
 * a launch whose insert did not return a lease cannot mutate a row it does not
 * own.
 */
export const settle = Effect.fn("BackgroundJobStore.settle")(function* (
  db: DatabaseService,
  info: BackgroundJob.Info,
  lease: Lease,
) {
  const now = yield* Clock.currentTimeMillis
  const row = yield* db
    .update(BackgroundJobTable)
    .set({
      status: info.status,
      completed_at: info.completed_at ?? now,
      output: info.output === undefined ? null : tail(info.output),
      error: info.error ?? null,
      lease_until: null,
      heartbeat_at: now,
      cancel_requested_at: null,
    })
    .where(
      and(
        eq(BackgroundJobTable.id, info.id),
        eq(BackgroundJobTable.status, "running"),
        eq(BackgroundJobTable.runtime_id, lease.runtimeID),
        eq(BackgroundJobTable.fence, lease.fence),
        gt(BackgroundJobTable.lease_until, now),
      ),
    )
    .returning({ id: BackgroundJobTable.id })
    .get()
    .pipe(Effect.orDie)
  return row !== undefined
})

/**
 * Renew a live job's lease and atomically observe a remote cancellation. Once
 * another runtime wins the lease, this update returns no row and the local
 * process must stop publishing or settling the job.
 */
export const heartbeat = Effect.fn("BackgroundJobStore.heartbeat")(function* (
  db: DatabaseService,
  id: string,
  lease: Lease,
) {
  const now = yield* Clock.currentTimeMillis
  const row = yield* db
    .update(BackgroundJobTable)
    .set({ heartbeat_at: now, lease_until: now + LEASE_DURATION_MS })
    .where(
      and(
        eq(BackgroundJobTable.id, id),
        eq(BackgroundJobTable.status, "running"),
        eq(BackgroundJobTable.runtime_id, lease.runtimeID),
        eq(BackgroundJobTable.fence, lease.fence),
        gte(BackgroundJobTable.lease_until, now),
      ),
    )
    .returning({ cancelRequestedAt: BackgroundJobTable.cancel_requested_at })
    .get()
    .pipe(Effect.orDie)
  if (!row) return { renewed: false, cancelRequested: false } as const
  return { renewed: true, cancelRequested: row.cancelRequestedAt !== null } as const
})

export const get = Effect.fn("BackgroundJobStore.get")(function* (db: DatabaseService, id: string) {
  const row = yield* db.select().from(BackgroundJobTable).where(eq(BackgroundJobTable.id, id)).get().pipe(Effect.orDie)
  return row === undefined ? undefined : fromRow(row)
})

export type ListQuery = {
  /** Owner session filter (the `(session_id, status)` index covers it). */
  sessionID?: SessionSchema.ID
  status?: BackgroundJob.Status
  /** Maximum rows returned; the list is always newest-first. */
  limit?: number
}

/**
 * Durable observation feed (gate 3): every stored row, newest first
 * (`started_at` desc, `id` desc tiebreak — ascending ids sort by creation).
 * This is the restart-time truth, not the live registry: rows reflect
 * persisted state only, within the best-effort durability contract.
 */
export const list = Effect.fn("BackgroundJobStore.list")(function* (db: DatabaseService, query: ListQuery = {}) {
  const conditions = [
    ...(query.sessionID === undefined ? [] : [eq(BackgroundJobTable.session_id, query.sessionID)]),
    ...(query.status === undefined ? [] : [eq(BackgroundJobTable.status, query.status)]),
  ]
  const rows = yield* db
    .select()
    .from(BackgroundJobTable)
    .where(conditions.length === 0 ? undefined : and(...conditions))
    .orderBy(desc(BackgroundJobTable.started_at), desc(BackgroundJobTable.id))
    .limit(query.limit ?? 50)
    .all()
    .pipe(Effect.orDie)
  return rows.map(fromRow)
})

/**
 * Request cancellation without claiming that a remote process has stopped.
 * While the owner lease is valid this only records a request; the owner must
 * observe it on its next heartbeat and perform the actual local interrupt. If
 * the lease is expired, fencing first marks the row interrupted/unknown and
 * invalidates the old capability. This is the safe clustered boundary used by
 * HTTP mutation.
 */
export const requestCancel = Effect.fn("BackgroundJobStore.requestCancel")(function* (db: DatabaseService, id: string) {
  const row = yield* db.select().from(BackgroundJobTable).where(eq(BackgroundJobTable.id, id)).get().pipe(Effect.orDie)
  if (!row) return { _tag: "NotFound" } as const
  if (row.status !== "running") return { _tag: "Settled", info: fromRow(row) } as const

  const now = yield* Clock.currentTimeMillis
  const leaseValid = row.lease_until !== null && row.lease_until > now
  if (leaseValid) {
    const requested = yield* db
      .update(BackgroundJobTable)
      .set({ cancel_requested_at: now })
      .where(
        and(
          eq(BackgroundJobTable.id, id),
          eq(BackgroundJobTable.status, "running"),
          gt(BackgroundJobTable.lease_until, now),
        ),
      )
      .returning()
      .get()
      .pipe(Effect.orDie)
    if (requested) return { _tag: "Requested", info: fromRow(requested) } as const
  }

  const stale = yield* db
    .update(BackgroundJobTable)
    .set({
      status: "interrupted",
      completed_at: now,
      error: STALE_OWNER_ERROR,
      lease_until: null,
      heartbeat_at: now,
      cancel_requested_at: null,
      fence: sql`${BackgroundJobTable.fence} + 1`,
    })
    .where(
      and(
        eq(BackgroundJobTable.id, id),
        eq(BackgroundJobTable.status, "running"),
        or(isNull(BackgroundJobTable.lease_until), lte(BackgroundJobTable.lease_until, now)),
      ),
    )
    .returning()
    .get()
    .pipe(Effect.orDie)
  if (stale) return { _tag: "StaleOwner", info: fromRow(stale) } as const

  const latest = yield* db
    .select()
    .from(BackgroundJobTable)
    .where(eq(BackgroundJobTable.id, id))
    .get()
    .pipe(Effect.orDie)
  return latest && latest.status !== "running"
    ? ({ _tag: "Settled", info: fromRow(latest) } as const)
    : ({ _tag: "NotFound" } as const)
})

/**
 * Restart recovery: atomically claim every expired `running` row owned by a
 * foreign runtime as `interrupted`. A live owner with a valid heartbeat is not
 * touched, even if another runtime starts at the same time. The guarded
 * UPDATE…RETURNING increments the fence so an old owner can no longer settle.
 */
export const recover = Effect.fn("BackgroundJobStore.recover")(function* (db: DatabaseService) {
  const now = yield* Clock.currentTimeMillis
  const stale = yield* db
    .select()
    .from(BackgroundJobTable)
    .where(
      and(
        eq(BackgroundJobTable.status, "running"),
        ne(BackgroundJobTable.runtime_id, runtimeID()),
        or(isNull(BackgroundJobTable.lease_until), lte(BackgroundJobTable.lease_until, now)),
      ),
    )
    .all()
    .pipe(Effect.orDie)
  const claimed: BackgroundJob.Info[] = []
  for (const row of stale) {
    // The process-global fence is the outer stale-owner check. A job lease can
    // be late because of a missed local heartbeat, but a live foreign runtime
    // fence proves that the old owner is still active and must not be fenced.
    const age = yield* fenceAge(db, row.runtime_id)
    if (age !== null && age <= FENCE_TTL_MS) continue
    const updated = yield* db
      .update(BackgroundJobTable)
      .set({
        status: "interrupted",
        completed_at: now,
        error: INTERRUPTED_ERROR,
        lease_until: null,
        heartbeat_at: now,
        cancel_requested_at: null,
        fence: sql`${BackgroundJobTable.fence} + 1`,
      })
      .where(
        and(
          eq(BackgroundJobTable.id, row.id),
          eq(BackgroundJobTable.status, "running"),
          eq(BackgroundJobTable.runtime_id, row.runtime_id),
          eq(BackgroundJobTable.fence, row.fence),
          or(isNull(BackgroundJobTable.lease_until), lte(BackgroundJobTable.lease_until, now)),
        ),
      )
      .returning()
      .get()
      .pipe(Effect.orDie)
    if (updated) claimed.push(fromRow(updated))
  }
  return claimed
})

/** Test-only helper for a deterministic row at the edge of its lease. */
export const expire = Effect.fn("BackgroundJobStore.expire")(function* (db: DatabaseService, id: string) {
  yield* db
    .update(BackgroundJobTable)
    .set({ lease_until: 0 })
    .where(eq(BackgroundJobTable.id, id))
    .run()
    .pipe(Effect.orDie)
})

/* ---- Runtime fence (lease-based stale-owner detection) ---- */

/**
 * Return the age (ms since heartbeat) of a runtime's fence, or `null` when no
 * fence row exists for that runtime. Rows written before the runtime-fence
 * migration, or by a runtime that released its fence during clean shutdown,
 * are therefore treated as expired by recovery.
 */
export const fenceAge = Effect.fn("BackgroundJobStore.fenceAge")(function* (
  db: DatabaseService,
  fenceRuntimeID: string,
) {
  const now = yield* Clock.currentTimeMillis
  const row = yield* db
    .select({ heartbeat_at: RuntimeFenceTable.heartbeat_at })
    .from(RuntimeFenceTable)
    .where(eq(RuntimeFenceTable.runtime_id, fenceRuntimeID))
    .get()
    .pipe(Effect.orDie)
  return row === undefined ? null : now - row.heartbeat_at
})

/**
 * Claim (or reclaim) the process-global fence row. Either a fresh row is
 * inserted, or a row whose heartbeat has expired is renamed for this runtime.
 * Returns false while another runtime holds a live fence; callers must not
 * treat a runtime id by itself as ownership.
 *
 * This is called once before job recovery and launch. Per-job leases and fences
 * remain the authoritative write capability for each background-job row.
 */
export const claimFence = Effect.fn("BackgroundJobStore.claimFence")(function* (db: DatabaseService) {
  const now = yield* Clock.currentTimeMillis
  const rid = runtimeID()
  const existing = yield* db.select().from(RuntimeFenceTable).get().pipe(Effect.orDie)
  if (existing === undefined) {
    yield* db.insert(RuntimeFenceTable).values({ runtime_id: rid, heartbeat_at: now }).run().pipe(Effect.orDie)
    return true
  }
  if (existing.runtime_id === rid) return true
  if (now - existing.heartbeat_at > FENCE_TTL_MS) {
    yield* db
      .update(RuntimeFenceTable)
      .set({ runtime_id: rid, heartbeat_at: now })
      .where(eq(RuntimeFenceTable.runtime_id, existing.runtime_id))
      .run()
      .pipe(Effect.orDie)
    return true
  }
  return false
})

/** Renew the heartbeat for the current process-global fence. */
export const heartbeatFence = Effect.fn("BackgroundJobStore.heartbeatFence")(function* (db: DatabaseService) {
  const now = yield* Clock.currentTimeMillis
  yield* db
    .update(RuntimeFenceTable)
    .set({ heartbeat_at: now })
    .where(eq(RuntimeFenceTable.runtime_id, runtimeID()))
    .run()
    .pipe(Effect.orDie)
})

/** Release the current process-global fence during clean shutdown. */
export const releaseFence = Effect.fn("BackgroundJobStore.releaseFence")(function* (db: DatabaseService) {
  yield* db.delete(RuntimeFenceTable).where(eq(RuntimeFenceTable.runtime_id, runtimeID())).run().pipe(Effect.orDie)
})
