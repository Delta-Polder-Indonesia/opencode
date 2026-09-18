import { integer, index, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { SessionTable } from "../sql"
import type { SessionSchema } from "../schema"

export type ProviderAttemptStatus = "prepared" | "dispatched" | "succeeded" | "failed" | "abandoned"
export type ProviderAttemptRecovery = "retry_ready" | "decision_required" | "auto_retrying" | "abandoned"

/** Durable boundary around one provider dispatch. Never infer dispatch from a process-local runner. */
export const SessionProviderAttemptTable = sqliteTable(
  "session_provider_attempt",
  {
    id: text().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    runtime_id: text().notNull(),
    fence: integer().notNull().default(1),
    step: integer().notNull(),
    status: text().$type<ProviderAttemptStatus>().notNull(),
    recovery: text().$type<ProviderAttemptRecovery>(),
    retry_count: integer().notNull().default(0),
    prepared_at: integer().notNull(),
    dispatched_at: integer(),
    completed_at: integer(),
    heartbeat_at: integer(),
    lease_until: integer(),
    next_retry_at: integer(),
    error: text(),
  },
  (table) => [index("session_provider_attempt_session_status_idx").on(table.session_id, table.status)],
)

/** Cluster ownership for a Session drain; the fence invalidates stale runners. */
export const SessionExecutionLeaseTable = sqliteTable("session_execution_lease", {
  session_id: text()
    .$type<SessionSchema.ID>()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  runtime_id: text().notNull(),
  fence: integer().notNull().default(1),
  heartbeat_at: integer(),
  lease_until: integer(),
})
