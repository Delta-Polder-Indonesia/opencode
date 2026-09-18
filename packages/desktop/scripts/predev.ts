import { $ } from "bun"
import { buildNodeServer } from "./utils"

await $`bun run install-electron`

await $`bun ./scripts/copy-icons.ts ${process.env.OPENCODE_CHANNEL ?? "dev"}`

await buildNodeServer()
