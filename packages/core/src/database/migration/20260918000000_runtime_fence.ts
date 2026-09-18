import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260918000000_runtime_fence",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`runtime_fence\` (
          \`runtime_id\` text PRIMARY KEY,
          \`heartbeat_at\` integer NOT NULL
        )
      `)
      yield* tx.run(
        `CREATE INDEX \`runtime_fence_expires_at_idx\` ON \`runtime_fence\` (\`heartbeat_at\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
