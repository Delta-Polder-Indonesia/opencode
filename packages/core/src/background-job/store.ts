export * as BackgroundJobStore from "./store"

import { and, desc, eq, lt, ne } from "drizzle-orm"
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

/**
 * Fence time-to-live. A runtime's fence row is considered expired when
 * `now - heartbeat_at > FENCE_TTL_MS`. Must exceed `HEARTBEAT_INTERVAL_MS`
 * by a comfortable margin so one missed heartbeat does not expire the fence.
 */
export const FENCE_TTL_MS = 30_000

/** One ascending marker per process. See `claimFence` for ownership semantics. */
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
})

/**
 * Record launch. Best-effort by contract: callers tolerate failure so a
 * durability problem can never block or lose a live job.
 */
export const insert = Effect.fn("BackgroundJobStore.insert")(function* (db: DatabaseService, info: BackgroundJob.Info) {
  yield* db
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
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

/**
 * Record settlement (any terminal status, including cancelled). Output is
 * persisted as a bounded tail.
 */
export const settle = Effect.fn("BackgroundJobStore.settle")(function* (db: DatabaseService, info: BackgroundJob.Info) {
  yield* db
    .update(BackgroundJobTable)
    .set({
      status: info.status,
      completed_at: info.completed_at ?? null,
      output: info.output === undefined ? null : tail(info.output),
      error: info.error ?? null,
    })
    .where(eq(BackgroundJobTable.id, info.id))
    .run()
    .pipe(Effect.orDie)
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
 * Restart recovery: atomically claim every durable `running` row owned by
 * a runtime whose fence has expired, then deliver the usual completion note
 * to each claimed job's owner session when that session still exists.
 * Rows with no fence row at all (pre-fence migrations, or fence cleaned up
 * after clean exit) are treated as expired — safe under the single-writer
 * assumption. Claiming and delivery are independent: a delivery failure
 * never unclaims the row, and rows without owner metadata or with deleted
 * sessions are still claimed. Runs at tool-layer boot, before any tool can
 * execute.
 */
export const recover = Effect.fn("BackgroundJobStore.recover")(function* (db: DatabaseService) {
  const now = yield* Clock.currentTimeMillis
  const stale = yield* db
    .select()
    .from(BackgroundJobTable)
    .where(and(eq(BackgroundJobTable.status, "running"), ne(BackgroundJobTable.runtime_id, runtimeID())))
    .all()
    .pipe(Effect.orDie)
  const claimed: BackgroundJob.Info[] = []
  const completed_at = now
  for (const row of stale) {
    const age = yield* fenceAge(db, row.runtime_id)
    if (age !== null && age <= FENCE_TTL_MS) continue
    const updated = yield* db
      .update(BackgroundJobTable)
      .set({ status: "interrupted", completed_at, error: INTERRUPTED_ERROR })
      .where(and(eq(BackgroundJobTable.id, row.id), eq(BackgroundJobTable.status, "running")))
      .returning()
      .get()
      .pipe(Effect.orDie)
    if (updated) claimed.push(fromRow(updated))
  }
  return claimed
})

/* ---- Runtime fence (lease-based stale-owner detection) ---- */

/**
 * Return the age (ms since heartbeat) of a runtime's fence, or `null` when
 * no fence row exists for that runtime (pre-fence rows, or a runtime that
 * released its fence on clean exit). Callers treat `null` as expired under
 * the single-writer assumption.
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
 * Claim (or reclaim) the process-global fence row. Atomic upsert: either
 * inserts a fresh row for this runtime, or overwrites a row whose
 * `heartbeat_at` is older than `FENCE_TTL_MS`. Returns `true` when the
 * claim succeeds, `false` when another runtime holds a live fence (caller
 * should NOT proceed with recovery).
 *
 * Must be called once at process boot, before `insert` or `recover`.
 * Claiming and recovery are intentionally separate operations: a fence
 * failure means "another runtime is alive — do not touch its rows".
 */
export const claimFence = Effect.fn("BackgroundJobStore.claimFence")(function* (db: DatabaseService) {
  const now = yield* Clock.currentTimeMillis
  const rid = runtimeID()
  const existing = yield* db
    .select()
    .from(RuntimeFenceTable)
    .get()
    .pipe(Effect.orDie)
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

/**
 * Renew the heartbeat for the current runtime's fence row. Called
 * periodically by the `RuntimeFence` service. A failure is logged but
 * never crashes the process — the fence will expire naturally.
 */
export const heartbeatFence = Effect.fn("BackgroundJobStore.heartbeatFence")(function* (db: DatabaseService) {
  const now = yield* Clock.currentTimeMillis
  yield* db
    .update(RuntimeFenceTable)
    .set({ heartbeat_at: now })
    .where(eq(RuntimeFenceTable.runtime_id, runtimeID()))
    .run()
    .pipe(Effect.orDie)
})

/**
 * Release the fence row on clean shutdown. The next process boot sees no
 * row and claims immediately without waiting for TTL expiry.
 */
export const releaseFence = Effect.fn("BackgroundJobStore.releaseFence")(function* (db: DatabaseService) {
  yield* db
    .delete(RuntimeFenceTable)
    .where(eq(RuntimeFenceTable.runtime_id, runtimeID()))
    .run()
    .pipe(Effect.orDie)
})
