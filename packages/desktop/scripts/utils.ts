import { $ } from "bun"
import { existsSync } from "node:fs"
import { join } from "node:path"

export type Channel = "dev" | "beta" | "prod"

export function resolveChannel(): Channel {
  const raw = Bun.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  if (raw === "latest") return "prod"
  return "dev"
}

/**
 * Fork note: upstream downloads a Rust CLI (`@opencode-ai/cli-*`) into
 * `resources/opencode-cli`. This fork's server is a bundled Node entrypoint
 * (`packages/opencode/dist/node/node.js`) resolved into the main process by
 * electron-vite (`virtual:opencode-server`), so there is no separate CLI
 * resource to download.
 *
 * `build-node.ts` imports `@opencode-ai/script`, which reads
 * `.github/TEAM_MEMBERS` (committed in this repo) and a models.dev JSON
 * snapshot. A committed fixture keeps the build reproducible without
 * network access; `MODELS_DEV_API_JSON` still overrides it.
 */
export async function buildNodeServer() {
  const env: Record<string, string> = {}
  if (!Bun.env.MODELS_DEV_API_JSON) {
    const modelsFixture = join(import.meta.dir, "../../opencode/test/tool/fixtures/models-api.json")
    if (existsSync(modelsFixture)) env.MODELS_DEV_API_JSON = modelsFixture
  }
  await $`cd ../opencode && bun script/build-node.ts`.env(env)
}
