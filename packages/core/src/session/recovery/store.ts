export * as SessionRecoveryStore from "./store"

import { and, asc, eq, gt, gte, isNull, lte, ne, or, sql } from "drizzle-orm"
import { Clock, Effect } from "effect"
import type { Database } from "../../database/database"
import { Identifier } from "../../id/id"
import { BackgroundJobStore } from "../../background-job/store"
import { SessionSchema } from "../schema"
import {
  SessionExecutionLeaseTable,
  SessionProviderAttemptTable,
  type ProviderAttemptRecovery,
  type ProviderAttemptStatus,
} from "./sql"

type DatabaseService = Database.Interface["db"]

export const AUTO_RETRY_BUDGET = 1
export const EXPLICIT_RETRY_BUDGET = 2
export const RETRY_BACKOFF_MS = 1_000
export const ATTEMPT_LEASE_DURATION_MS = BackgroundJobStore.LEASE_DURATION_MS

export const UNKNOWN_DISPATCH_ERROR =
  "The process ended after provider dispatch began; the provider outcome is unknown and was not retried automatically."
export const SAFE_RETRY_ERROR =
  "The provider attempt was prepared but never dispatched; it was superseded by a safe retry."
export const EXPLICIT_ABANDON_ERROR = "The ambiguous provider attempt was explicitly abandoned."

export type Lease = {
  readonly runtimeID: string
  readonly fence: number
}

export type Info = {
  readonly id: string
  readonly sessionID: SessionSchema.ID
  readonly runtimeID: string
  readonly fence: number
  readonly step: number
  readonly status: ProviderAttemptStatus
  readonly recovery?: ProviderAttemptRecovery
  readonly retryCount: number
  readonly preparedAt: number
  readonly dispatchedAt?: number
  readonly completedAt?: number
  readonly nextRetryAt?: number
  readonly error?: string
}

export type Discovery =
  | { readonly _tag: "Prepared"; readonly attempt: Info }
  | { readonly _tag: "Dispatched"; readonly attempt: Info }

export type RetryResult =
  | { readonly _tag: "Retried"; readonly attempt: Info }
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "NotRetryable"; readonly attempt: Info }
  | { readonly _tag: "ConfirmationRequired"; readonly attempt: Info }
  | { readonly _tag: "BudgetExhausted"; readonly attempt: Info }

const fromRow = (row: typeof SessionProviderAttemptTable.$inferSelect): Info => ({
  id: row.id,
  sessionID: row.session_id,
  runtimeID: row.runtime_id,
  fence: row.fence,
  step: row.step,
  status: row.status,
  ...(row.recovery === null ? {} : { recovery: row.recovery }),
  retryCount: row.retry_count,
  preparedAt: row.prepared_at,
  ...(row.dispatched_at === null ? {} : { dispatchedAt: row.dispatched_at }),
  ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
  ...(row.next_retry_at === null ? {} : { nextRetryAt: row.next_retry_at }),
  ...(row.error === null ? {} : { error: row.error }),
})

export const prepare = Effect.fn("SessionRecoveryStore.prepare")(function* (
  db: DatabaseService,
  input: { readonly sessionID: SessionSchema.ID; readonly step: number; readonly retryCount?: number },
) {
  const now = yield* Clock.currentTimeMillis
  const id = Identifier.ascending("attempt")
  const row = yield* db
    .insert(SessionProviderAttemptTable)
    .values({
      id,
      session_id: input.sessionID,
      runtime_id: BackgroundJobStore.runtimeID(),
      fence: 1,
      step: input.step,
      status: "prepared",
      retry_count: input.retryCount ?? 0,
      prepared_at: now,
      lease_until: undefined,
    } as never)
    .returning()
    .get()
    .pipe(Effect.orDie)
  return fromRow(row)
})

export const markDispatched = Effect.fn("SessionRecoveryStore.markDispatched")(function* (
  db: DatabaseService,
  attempt: Info,
) {
  const now = yield* Clock.currentTimeMillis
  const updated = yield* db
    .update(SessionProviderAttemptTable)
    .set({
      status: "dispatched",
      dispatched_at: now,
      lease_until: now + ATTEMPT_LEASE_DURATION_MS,
      heartbeat_at: now,
    } as never)
    .where(
      and(
        eq(SessionProviderAttemptTable.id, attempt.id),
        eq(SessionProviderAttemptTable.status, "prepared"),
        eq(SessionProviderAttemptTable.runtime_id, attempt.runtimeID),
        eq(SessionProviderAttemptTable.fence, attempt.fence),
      ),
    )
    .returning()
    .get()
    .pipe(Effect.orDie)
  return updated !== undefined
})

export const heartbeat = Effect.fn("SessionRecoveryStore.heartbeat")(function* (db: DatabaseService, attempt: Info) {
  const now = yield* Clock.currentTimeMillis
  const updated = yield* db
    .update(SessionProviderAttemptTable)
    .set({ heartbeat_at: now, lease_until: now + ATTEMPT_LEASE_DURATION_MS } as never)
    .where(
      and(
        eq(SessionProviderAttemptTable.id, attempt.id),
        eq(SessionProviderAttemptTable.status, "dispatched"),
        eq(SessionProviderAttemptTable.runtime_id, attempt.runtimeID),
        eq(SessionProviderAttemptTable.fence, attempt.fence),
        gte(SessionProviderAttemptTable.lease_until, now),
      ),
    )
    .returning({ id: SessionProviderAttemptTable.id })
    .get()
    .pipe(Effect.orDie)
  return updated !== undefined
})

export const settle = Effect.fn("SessionRecoveryStore.settle")(function* (
  db: DatabaseService,
  attempt: Info,
  status: Extract<ProviderAttemptStatus, "succeeded" | "failed" | "abandoned">,
  error?: string,
) {
  const now = yield* Clock.currentTimeMillis
  const updated = yield* db
    .update(SessionProviderAttemptTable)
    .set({
      status,
      recovery: status === "abandoned" ? "decision_required" : null,
      completed_at: now,
      lease_until: null,
      heartbeat_at: now,
      error: error ?? null,
    } as never)
    .where(
      and(
        eq(SessionProviderAttemptTable.id, attempt.id),
        eq(SessionProviderAttemptTable.status, "dispatched"),
        eq(SessionProviderAttemptTable.runtime_id, attempt.runtimeID),
        eq(SessionProviderAttemptTable.fence, attempt.fence),
        gt(SessionProviderAttemptTable.lease_until, now),
      ),
    )
    .returning()
    .get()
    .pipe(Effect.orDie)
  return updated !== undefined
})

/**
 * Startup discovery is intentionally non-executing: it fences old runners,
 * marks dispatched ambiguity as decision-required, and makes preparation-only
 * work retry-ready after a bounded backoff. No provider call is started here.
 */
export const discover = Effect.fn("SessionRecoveryStore.discover")(function* (db: DatabaseService) {
  const now = yield* Clock.currentTimeMillis
  const rows = yield* db
    .select()
    .from(SessionProviderAttemptTable)
    .where(
      and(
        ne(SessionProviderAttemptTable.runtime_id, BackgroundJobStore.runtimeID()),
        or(
          and(eq(SessionProviderAttemptTable.status, "prepared"), isNull(SessionProviderAttemptTable.recovery)),
          and(
            eq(SessionProviderAttemptTable.status, "dispatched"),
            or(isNull(SessionProviderAttemptTable.lease_until), lte(SessionProviderAttemptTable.lease_until, now)),
          ),
        ),
      ),
    )
    .all()
    .pipe(Effect.orDie)
  const discovered: Discovery[] = []
  for (const row of rows) {
    const update =
      row.status === "prepared"
        ? {
            recovery: "retry_ready" as const,
            next_retry_at: now + RETRY_BACKOFF_MS,
            lease_until: null,
            heartbeat_at: now,
            fence: sql`${SessionProviderAttemptTable.fence} + 1`,
          }
        : {
            status: "abandoned" as const,
            recovery: "decision_required" as const,
            completed_at: now,
            lease_until: null,
            heartbeat_at: now,
            error: UNKNOWN_DISPATCH_ERROR,
            fence: sql`${SessionProviderAttemptTable.fence} + 1`,
          }
    const updated = yield* db
      .update(SessionProviderAttemptTable)
      .set(update as never)
      .where(
        and(
          eq(SessionProviderAttemptTable.id, row.id),
          eq(SessionProviderAttemptTable.runtime_id, row.runtime_id),
          eq(SessionProviderAttemptTable.fence, row.fence),
          eq(SessionProviderAttemptTable.status, row.status),
          ...(row.status === "dispatched"
            ? [or(isNull(SessionProviderAttemptTable.lease_until), lte(SessionProviderAttemptTable.lease_until, now))]
            : []),
        ),
      )
      .returning()
      .get()
      .pipe(Effect.orDie)
    if (!updated) continue
    const attempt = fromRow(updated)
    discovered.push(row.status === "prepared" ? { _tag: "Prepared", attempt } : { _tag: "Dispatched", attempt })
  }
  return discovered
})

/** Move one preparation-only recovery out of the way before a safe automatic retry. */
export const consumeSafeRetry = Effect.fn("SessionRecoveryStore.consumeSafeRetry")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  const now = yield* Clock.currentTimeMillis
  const row = yield* db
    .select()
    .from(SessionProviderAttemptTable)
    .where(
      and(
        eq(SessionProviderAttemptTable.session_id, sessionID),
        eq(SessionProviderAttemptTable.status, "prepared"),
        eq(SessionProviderAttemptTable.recovery, "retry_ready"),
        lte(SessionProviderAttemptTable.next_retry_at, now),
      ),
    )
    .orderBy(asc(SessionProviderAttemptTable.prepared_at))
    .get()
    .pipe(Effect.orDie)
  if (!row || row.retry_count >= AUTO_RETRY_BUDGET) return undefined
  const updated = yield* db
    .update(SessionProviderAttemptTable)
    .set({
      status: "abandoned",
      recovery: "auto_retrying",
      completed_at: now,
      lease_until: null,
      heartbeat_at: now,
      error: SAFE_RETRY_ERROR,
      fence: sql`${SessionProviderAttemptTable.fence} + 1`,
    })
    .where(
      and(
        eq(SessionProviderAttemptTable.id, row.id),
        eq(SessionProviderAttemptTable.status, "prepared"),
        eq(SessionProviderAttemptTable.recovery, "retry_ready"),
        eq(SessionProviderAttemptTable.fence, row.fence),
        lte(SessionProviderAttemptTable.next_retry_at, now),
      ),
    )
    .returning({ retryCount: SessionProviderAttemptTable.retry_count })
    .get()
    .pipe(Effect.orDie)
  return updated ? updated.retryCount + 1 : undefined
})

export const retry = Effect.fn("SessionRecoveryStore.retry")(function* (
  db: DatabaseService,
  id: string,
  confirmAmbiguous = false,
) {
  const row = yield* db
    .select()
    .from(SessionProviderAttemptTable)
    .where(eq(SessionProviderAttemptTable.id, id))
    .get()
    .pipe(Effect.orDie)
  if (!row) return { _tag: "NotFound" } as const
  const attempt = fromRow(row)
  if (row.status !== "abandoned") return { _tag: "NotRetryable", attempt } as const
  if (row.recovery === "decision_required" && !confirmAmbiguous)
    return { _tag: "ConfirmationRequired", attempt } as const
  if (row.retry_count >= EXPLICIT_RETRY_BUDGET) return { _tag: "BudgetExhausted", attempt } as const
  const now = yield* Clock.currentTimeMillis
  const updated = yield* db
    .update(SessionProviderAttemptTable)
    .set({
      status: "prepared",
      recovery: "retry_ready",
      runtime_id: BackgroundJobStore.runtimeID(),
      next_retry_at: now + RETRY_BACKOFF_MS,
      prepared_at: now,
      dispatched_at: null,
      completed_at: null,
      lease_until: null,
      heartbeat_at: now,
      error: null,
      retry_count: row.retry_count + 1,
      fence: sql`${SessionProviderAttemptTable.fence} + 1`,
    })
    .where(and(eq(SessionProviderAttemptTable.id, id), eq(SessionProviderAttemptTable.status, "abandoned")))
    .returning()
    .get()
    .pipe(Effect.orDie)
  return updated ? ({ _tag: "Retried", attempt: fromRow(updated) } as const) : ({ _tag: "NotFound" } as const)
})

export const abandon = Effect.fn("SessionRecoveryStore.abandon")(function* (db: DatabaseService, id: string) {
  const now = yield* Clock.currentTimeMillis
  const updated = yield* db
    .update(SessionProviderAttemptTable)
    .set({
      status: "abandoned",
      recovery: "abandoned",
      completed_at: now,
      lease_until: null,
      heartbeat_at: now,
      error: EXPLICIT_ABANDON_ERROR,
      fence: sql`${SessionProviderAttemptTable.fence} + 1`,
    })
    .where(and(eq(SessionProviderAttemptTable.id, id), eq(SessionProviderAttemptTable.status, "abandoned")))
    .returning()
    .get()
    .pipe(Effect.orDie)
  return updated ? fromRow(updated) : undefined
})

export const list = Effect.fn("SessionRecoveryStore.list")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  const rows = yield* db
    .select()
    .from(SessionProviderAttemptTable)
    .where(eq(SessionProviderAttemptTable.session_id, sessionID))
    .orderBy(asc(SessionProviderAttemptTable.prepared_at))
    .all()
    .pipe(Effect.orDie)
  return rows.map(fromRow)
})

export const pending = Effect.fn("SessionRecoveryStore.pending")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  const rows = yield* db
    .select()
    .from(SessionProviderAttemptTable)
    .where(
      and(
        eq(SessionProviderAttemptTable.session_id, sessionID),
        or(
          eq(SessionProviderAttemptTable.recovery, "retry_ready"),
          eq(SessionProviderAttemptTable.recovery, "decision_required"),
        ),
      ),
    )
    .orderBy(asc(SessionProviderAttemptTable.prepared_at))
    .all()
    .pipe(Effect.orDie)
  return rows.map(fromRow)
})

/** Public lease primitives used by the clustered Session coordinator. */
export const sessionLease = {
  acquire: Effect.fn("SessionRecoveryStore.sessionLease.acquire")(function* (
    db: DatabaseService,
    sessionID: SessionSchema.ID,
  ) {
    const now = yield* Clock.currentTimeMillis
    const runtimeID = BackgroundJobStore.runtimeID()
    yield* db
      .insert(SessionExecutionLeaseTable)
      .values({
        session_id: sessionID,
        runtime_id: runtimeID,
        fence: 1,
        heartbeat_at: now,
        lease_until: now + ATTEMPT_LEASE_DURATION_MS,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    const row = yield* db
      .update(SessionExecutionLeaseTable)
      .set({
        runtime_id: runtimeID,
        fence: sql`${SessionExecutionLeaseTable.fence} + 1`,
        heartbeat_at: now,
        lease_until: now + ATTEMPT_LEASE_DURATION_MS,
      })
      .where(
        and(
          eq(SessionExecutionLeaseTable.session_id, sessionID),
          or(
            isNull(SessionExecutionLeaseTable.lease_until),
            lte(SessionExecutionLeaseTable.lease_until, now),
            eq(SessionExecutionLeaseTable.runtime_id, runtimeID),
          ),
        ),
      )
      .returning()
      .get()
      .pipe(Effect.orDie)
    return row ? ({ runtimeID: row.runtime_id, fence: row.fence } satisfies Lease) : undefined
  }),
  heartbeat: Effect.fn("SessionRecoveryStore.sessionLease.heartbeat")(function* (
    db: DatabaseService,
    sessionID: SessionSchema.ID,
    lease: Lease,
  ) {
    const now = yield* Clock.currentTimeMillis
    const row = yield* db
      .update(SessionExecutionLeaseTable)
      .set({ heartbeat_at: now, lease_until: now + ATTEMPT_LEASE_DURATION_MS })
      .where(
        and(
          eq(SessionExecutionLeaseTable.session_id, sessionID),
          eq(SessionExecutionLeaseTable.runtime_id, lease.runtimeID),
          eq(SessionExecutionLeaseTable.fence, lease.fence),
          gte(SessionExecutionLeaseTable.lease_until, now),
        ),
      )
      .returning({ id: SessionExecutionLeaseTable.session_id })
      .get()
      .pipe(Effect.orDie)
    return row !== undefined
  }),
  release: Effect.fn("SessionRecoveryStore.sessionLease.release")(function* (
    db: DatabaseService,
    sessionID: SessionSchema.ID,
    lease: Lease,
  ) {
    yield* db
      .update(SessionExecutionLeaseTable)
      .set({ lease_until: 0, heartbeat_at: yield* Clock.currentTimeMillis })
      .where(
        and(
          eq(SessionExecutionLeaseTable.session_id, sessionID),
          eq(SessionExecutionLeaseTable.runtime_id, lease.runtimeID),
          eq(SessionExecutionLeaseTable.fence, lease.fence),
        ),
      )
      .run()
      .pipe(Effect.orDie)
  }),
}
