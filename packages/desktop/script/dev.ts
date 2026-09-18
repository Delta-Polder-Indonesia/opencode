#!/usr/bin/env bun
/**
 * Development launcher: starts the Vite renderer dev server on loopback, waits
 * for it to answer, rebuilds the main/preload bundles, then launches Electron
 * pointing at the dev server.
 *
 * Run the backend separately (from packages/opencode):
 *   bun run ./src/index.ts serve --port 4096
 */
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const rendererUrl = process.env.OPENCODE_DESKTOP_RENDERER_URL ?? "http://127.0.0.1:4455"

const vite = Bun.spawn(["bun", "x", "vite", "--config", "vite.renderer.config.ts"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
})

async function waitForRenderer(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(rendererUrl, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) return true
    } catch {
      // dev server not up yet
    }
    await Bun.sleep(300)
  }
  return false
}

function stopVite() {
  try {
    vite.kill()
  } catch {
    // already gone
  }
}

if (!(await waitForRenderer())) {
  console.error(`[desktop] renderer dev server did not become ready at ${rendererUrl}`)
  stopVite()
  process.exit(1)
}

const build = Bun.spawn(["bun", "run", "script/build.ts", "--native-only"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
})
if ((await build.exited) !== 0) {
  stopVite()
  process.exit(1)
}

const electron = Bun.spawn(["bun", "x", "electron", "dist/main/index.cjs"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
  env: { ...process.env, OPENCODE_DESKTOP_RENDERER_URL: rendererUrl },
})

const shutdown = () => {
  stopVite()
  try {
    electron.kill()
  } catch {
    // already gone
  }
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)

const code = await electron.exited
stopVite()
process.exit(code)
