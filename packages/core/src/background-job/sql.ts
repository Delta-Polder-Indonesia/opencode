import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import type { SessionSchema } from "../session/schema"
import { SessionTable } from "../session/sql"
import type { BackgroundJob } from "../background-job"

/**
 * Durable status for tool-launched background jobs (gate 1). The live
 * `BackgroundJob` registry stays intentionally in-memory; this table records
 * enough truth for restart recovery and post-restart observation. See
 * specs/v2/background-jobs.md.
 */
export const BackgroundJobTable = sqliteTable(
  "background_job",
  {
    id: text().primaryKey(),
    type: text().notNull(),
    title: text(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    status: text().$type<BackgroundJob.Status>().notNull(),
    runtime_id: text().notNull(),
    started_at: integer().notNull(),
    completed_at: integer(),
    /** Bounded tail of the settled output; the registry keeps the full text. */
    output: text(),
    error: text(),
    metadata: text({ mode: "json" }).$type<Record<string, unknown>>(),
  },
  (table) => [index("background_job_session_status_idx").on(table.session_id, table.status)],
)
