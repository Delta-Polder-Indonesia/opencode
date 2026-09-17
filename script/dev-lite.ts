#!/usr/bin/env bun
// Mode "lite": jalankan server opencode + UI web di browser, tanpa Electron.
// Pakai: bun dev:lite   (buka http://localhost:3000)
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const port = process.env.OPENCODE_PORT ?? "4096"
const uiPort = process.env.OPENCODE_UI_PORT ?? "3000"
const root = fileURLToPath(new URL("..", import.meta.url))

// Bun.spawn does not reliably resolve the `bun` command on Windows. Reuse the
// executable that started this script so this also works when Bun was started
// from a shell, a package manager, or an absolute path.
const bun = process.execPath

const server = Bun.spawn([bun, "run", "src/index.ts", "serve", "--hostname", "0.0.0.0", "--port", port], {
  cwd: join(root, "packages", "opencode"),
  stdio: ["inherit", "inherit", "inherit"],
})
const ui = Bun.spawn([bun, "x", "vite", "--port", uiPort], {
  cwd: join(root, "packages", "app"),
  stdio: ["inherit", "inherit", "inherit"],
  env: { ...process.env, VITE_OPENCODE_SERVER_PORT: port },
})

const stop = () => {
  server.kill()
  ui.kill()
}
process.on("SIGINT", stop)
process.on("SIGTERM", stop)
await Promise.race([server.exited, ui.exited])
stop()
