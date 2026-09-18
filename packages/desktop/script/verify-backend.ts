#!/usr/bin/env bun
/**
 * Integration check for the backend supervisor against a REAL opencode server.
 *
 * This is not a unit test: it spawns the backend staged in `resources/backend`,
 * waits for it to become healthy, verifies that the generated credentials are
 * actually enforced, then shuts it down and confirms no process is left behind.
 *
 *   bun run script/verify-backend.ts
 */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BackendSupervisor } from "../src/main/backend"
import { DesktopLog } from "../src/main/log"
import { backendBinaryName } from "../src/main/paths"

const root = join(import.meta.dir, "..")
const repo = join(root, "..", "..")
const binary = join(root, "resources", "backend", backendBinaryName(process.platform))

const log = new DesktopLog(mkdtempSync(join(tmpdir(), "opencode-desktop-verify-")))
process.env.OPENCODE_REPO = repo

const supervisor = new BackendSupervisor({
  binary,
  cwd: mkdtempSync(join(tmpdir(), "opencode-desktop-cwd-")),
  log,
  policy: { startupTimeoutMs: 120_000 },
})

const failures: string[] = []
function check(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures.push(name)
}

console.log(`starting backend from ${binary}`)
const state = await supervisor.start()

check("backend reaches the ready phase", state.phase.phase === "ready", JSON.stringify(state.phase))
if (state.phase.phase !== "ready") {
  process.exit(1)
}

const url = state.phase.url
check("backend bound a loopback address", new URL(url).hostname === "127.0.0.1", url)

const authed = await fetch(`${url}/api/health`, { headers: { Authorization: supervisor.authHeader() } })
check("health responds 200 with generated credentials", authed.status === 200, `http ${authed.status}`)
check("health payload reports healthy", (await authed.json().catch(() => ({}))).healthy === true)

const anonymous = await fetch(`${url}/api/health`)
check("health rejects unauthenticated requests", anonymous.status === 401, `http ${anonymous.status}`)

const wrong = await fetch(`${url}/api/health`, {
  headers: { Authorization: `Basic ${Buffer.from("opencode:wrong").toString("base64")}` },
})
check("health rejects the wrong password", wrong.status === 401, `http ${wrong.status}`)

await supervisor.stop()
check("supervisor reports stopped", supervisor.current().phase.phase === "stopped")

// Give the OS a moment to reap, then confirm the port is free again.
await Bun.sleep(1_000)
const afterStop = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2_000) })
  .then((response) => `http ${response.status}`)
  .catch(() => "refused")
check("port is released after shutdown", afterStop === "refused", afterStop)

console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nall checks passed")
process.exit(failures.length ? 1 : 0)
