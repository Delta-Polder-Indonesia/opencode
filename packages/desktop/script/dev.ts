#!/usr/bin/env bun
/**
 * Development launcher: starts the Vite renderer dev server on loopback, waits
 * for it to answer, rebuilds the main/preload bundles, then launches Electron
 * pointing at the dev server.
 *
 * By default the shell starts and supervises its own backend from
 * `resources/backend` (stage it once with `bun run script/backend.ts`).
 *
 * To use a server you run yourself instead, set OPENCODE_DESKTOP_SERVER_URL —
 * the shell will connect to it and will not spawn or kill anything:
 *   cd packages/opencode && bun run ./src/index.ts serve --port 4096
 *   OPENCODE_DESKTOP_SERVER_URL=http://127.0.0.1:4096 bun run dev
 */
import { existsSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const backendBinary = join(root, "resources", "backend", process.platform === "win32" ? "opencode.exe" : "opencode")

if (!process.env.OPENCODE_DESKTOP_SERVER_URL && !existsSync(backendBinary)) {
  console.warn(
    `[desktop] no backend executable at ${backendBinary}.\n` +
      `[desktop] run \`bun run script/backend.ts\` to build one, or set ` +
      `OPENCODE_DESKTOP_SERVER_URL to use a server you start yourself.`,
  )
}
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
