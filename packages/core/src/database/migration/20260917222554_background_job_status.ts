import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260917222554_background_job_status",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`background_job\` (
          \`id\` text PRIMARY KEY,
          \`type\` text NOT NULL,
          \`title\` text,
          \`session_id\` text,
          \`status\` text NOT NULL,
          \`runtime_id\` text NOT NULL,
          \`started_at\` integer NOT NULL,
          \`completed_at\` integer,
          \`output\` text,
          \`error\` text,
          \`metadata\` text,
          CONSTRAINT \`fk_background_job_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`background_job_session_status_idx\` ON \`background_job\` (\`session_id\`,\`status\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
