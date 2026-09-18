import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

/**
 * Durable fencing for background jobs. Nullable lease columns keep upgrades
 * compatible with rows created by gate 1; a null lease is intentionally
 * treated as expired and is claimed before any remote mutation.
 */
export default {
  id: "20260918000100_background_job_fencing",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`background_job\` ADD \`fence\` integer NOT NULL DEFAULT 1;`)
      yield* tx.run(`ALTER TABLE \`background_job\` ADD \`lease_until\` integer;`)
      yield* tx.run(`ALTER TABLE \`background_job\` ADD \`heartbeat_at\` integer;`)
      yield* tx.run(`ALTER TABLE \`background_job\` ADD \`cancel_requested_at\` integer;`)
      yield* tx.run(
        `UPDATE \`background_job\` SET \`lease_until\` = 0, \`heartbeat_at\` = \`started_at\` WHERE \`status\` = 'running' AND \`lease_until\` IS NULL;`,
      )
      yield* tx.run(
        `CREATE INDEX \`background_job_runtime_lease_idx\` ON \`background_job\` (\`runtime_id\`,\`status\`,\`lease_until\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
