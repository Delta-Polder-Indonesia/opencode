#!/usr/bin/env bun
// Mode "lite": jalankan server opencode + UI web di browser, tanpa Electron.
// Pakai: bun dev:lite   (buka http://localhost:3000)
const port = process.env.OPENCODE_PORT ?? "4096"
const uiPort = process.env.OPENCODE_UI_PORT ?? "3000"
// fileURLToPath menghasilkan path Windows yang valid (E:\...), sedangkan URL.pathname menghasilkan /E:/... yang gagal sebagai cwd.
const root = Bun.fileURLToPath(new URL("..", import.meta.url))
// process.execPath = path absolut ke binary bun yang sedang berjalan.
// Di Windows, Bun.spawn("bun") gagal ENOENT karena uv_spawn tidak mencari "bun" (tanpa .exe) di PATH.
const bun = process.execPath

const server = Bun.spawn([bun, "run", "src/index.ts", "serve", "--hostname", "0.0.0.0", "--port", port], {
  cwd: `${root}packages/opencode`,
  stdio: ["inherit", "inherit", "inherit"],
})
const ui = Bun.spawn([bun, "x", "vite", "--port", uiPort], {
  cwd: `${root}packages/app`,
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
