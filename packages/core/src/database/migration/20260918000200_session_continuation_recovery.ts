import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

/** Durable provider-attempt boundaries and clustered Session ownership. */
export default {
  id: "20260918000200_session_continuation_recovery",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_provider_attempt\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`runtime_id\` text NOT NULL,
          \`fence\` integer DEFAULT 1 NOT NULL,
          \`step\` integer NOT NULL,
          \`status\` text NOT NULL,
          \`recovery\` text,
          \`retry_count\` integer DEFAULT 0 NOT NULL,
          \`prepared_at\` integer NOT NULL,
          \`dispatched_at\` integer,
          \`completed_at\` integer,
          \`heartbeat_at\` integer,
          \`lease_until\` integer,
          \`next_retry_at\` integer,
          \`error\` text,
          CONSTRAINT \`fk_session_provider_attempt_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`session_provider_attempt_session_status_idx\` ON \`session_provider_attempt\` (\`session_id\`,\`status\`);`,
      )
      yield* tx.run(`
        CREATE TABLE \`session_execution_lease\` (
          \`session_id\` text PRIMARY KEY,
          \`runtime_id\` text NOT NULL,
          \`fence\` integer DEFAULT 1 NOT NULL,
          \`heartbeat_at\` integer,
          \`lease_until\` integer,
          CONSTRAINT \`fk_session_execution_lease_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
