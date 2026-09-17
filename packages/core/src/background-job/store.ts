export * as BackgroundJobStore from "./store"

import { and, eq, ne } from "drizzle-orm"
import { Clock, Effect } from "effect"
import type { Database } from "../database/database"
import { Identifier } from "../id/id"
import { BackgroundJob } from "../background-job"
import { SessionSchema } from "../session/schema"
import { BackgroundJobTable } from "./sql"

type DatabaseService = Database.Interface["db"]

/**
 * Bounded durable retention for settled output. The live registry keeps the
 * full output for the process lifetime; the row retains only the tail so a
 * crash cannot fill the database with megabytes of shell output per job.
 */
export const MAX_PERSISTED_OUTPUT_BYTES = 16_384

export const INTERRUPTED_ERROR = "Process exited while this job was running; its outcome is unknown."

/**
 * One ascending marker per process. Recovery claims only rows whose marker
 * differs, so current-runtime rows are never touched (also making recovery
 * idempotent across Location rebuilds within one process). This is NOT
 * ownership fencing: correctness still assumes one live runtime per
 * database. See specs/v2/background-jobs.md.
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

/**
 * Restart recovery: atomically claim every `running` row owned by a foreign
 * runtime as `interrupted` and return the claimed rows. Rows of the current
 * runtime and settled rows are never touched. Each claim is a guarded
 * UPDATE…RETURNING, so concurrent recoveries cannot double-claim a row.
 */
export const recover = Effect.fn("BackgroundJobStore.recover")(function* (db: DatabaseService) {
  const stale = yield* db
    .select()
    .from(BackgroundJobTable)
    .where(and(eq(BackgroundJobTable.status, "running"), ne(BackgroundJobTable.runtime_id, runtimeID())))
    .all()
    .pipe(Effect.orDie)
  const claimed: BackgroundJob.Info[] = []
  const completed_at = yield* Clock.currentTimeMillis
  for (const row of stale) {
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
