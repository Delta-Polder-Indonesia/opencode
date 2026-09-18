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

/**
 * Stops a child and everything it spawned.
 *
 * `bun x vite` and `bun x electron` are launchers: killing them on Windows
 * leaves the real process alive. For Vite that means the port stays held and
 * the next `bun run dev` fails with "Port 4455 is already in use".
 * `taskkill /T` takes the whole tree down.
 */
function killTree(child: Bun.Subprocess) {
  if (process.platform === "win32" && child.pid) {
    try {
      Bun.spawnSync(["taskkill", "/PID", String(child.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" })
      return
    } catch {
      // fall through
    }
  }
  try {
    child.kill()
  } catch {
    // already gone
  }
}

function stopVite() {
  killTree(vite)
}

/**
 * Waits for the dev server to answer.
 *
 * The timeout is generous because a cold Vite start on Windows can take well
 * over two minutes. But we also watch the process itself: `strictPort` makes
 * Vite exit immediately when the port is taken, and waiting out the full
 * timeout after that just buries the real error under a misleading one.
 */
async function waitForRenderer(timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (vite.exitCode !== null) return "exited" as const
    try {
      const response = await fetch(rendererUrl, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) return "ready" as const
    } catch {
      // dev server not up yet
    }
    await Bun.sleep(300)
  }
  return "timeout" as const
}

const rendererStatus = await waitForRenderer()
if (rendererStatus !== "ready") {
  const port = new URL(rendererUrl).port || "4455"
  if (rendererStatus === "exited") {
    console.error(
      `[desktop] the renderer dev server exited before it was ready.\n` +
        `[desktop] if the error above says port ${port} is already in use, another\n` +
        `[desktop] copy of this dev server is still running. Close it, or pick a\n` +
        `[desktop] different port with OPENCODE_DESKTOP_RENDERER_URL.`,
    )
  } else {
    console.error(`[desktop] renderer dev server did not become ready at ${rendererUrl}`)
  }
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
  killTree(electron)
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)

const code = await electron.exited
stopVite()
process.exit(code)
