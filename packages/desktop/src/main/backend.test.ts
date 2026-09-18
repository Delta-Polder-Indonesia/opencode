import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BackendSupervisor } from "./backend"
import { DesktopLog } from "./log"

function fakeBinary() {
  const dir = mkdtempSync(join(tmpdir(), "opencode-desktop-backend-"))
  const binary = join(dir, "opencode")
  writeFileSync(binary, "#!/bin/sh\n", { mode: 0o755 })
  return { dir, binary }
}

function log() {
  return new DesktopLog(mkdtempSync(join(tmpdir(), "opencode-desktop-log-")))
}

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  exitCode: number | null = null
  pid = 4242
  killed: NodeJS.Signals[] = []
  kill(signal: NodeJS.Signals) {
    this.killed.push(signal)
    this.exitCode = 0
    queueMicrotask(() => this.emit("exit", 0, null))
    return true
  }
  say(line: string) {
    this.stdout.emit("data", Buffer.from(`${line}\n`))
  }
}

function supervisor(options?: {
  child?: FakeChild
  fetchFn?: typeof fetch
  spawnThrows?: boolean
  binaryMissing?: boolean
  startupTimeoutMs?: number
}) {
  const { dir, binary } = fakeBinary()
  const child = options?.child ?? new FakeChild()
  const instance = new BackendSupervisor({
    binary: options?.binaryMissing ? join(dir, "does-not-exist") : binary,
    cwd: dir,
    log: log(),
    policy: { startupTimeoutMs: options?.startupTimeoutMs ?? 2_000, healthIntervalMs: 5, shutdownGraceMs: 50 },
    spawnFn: (() => {
      if (options?.spawnThrows) throw new Error("EACCES")
      return child
    }) as never,
    fetchFn: options?.fetchFn ?? ((async () => new Response("{}", { status: 200 })) as unknown as typeof fetch),
  })
  return { instance, child }
}

describe("BackendSupervisor startup", () => {
  test("becomes ready once the backend reports a port and answers health", async () => {
    const { instance, child } = supervisor()
    const started = instance.start()
    queueMicrotask(() => child.say("opencode server listening on http://127.0.0.1:39915"))
    const state = await started
    expect(state.phase).toEqual({ phase: "ready", url: "http://127.0.0.1:39915" })
  })

  test("uses the port the backend actually chose, not a hardcoded one", async () => {
    const { instance, child } = supervisor()
    const started = instance.start()
    queueMicrotask(() => child.say("opencode server listening on http://127.0.0.1:45001"))
    const state = await started
    expect(state.phase).toMatchObject({ url: "http://127.0.0.1:45001" })
  })

  test("sends basic auth generated per instance", async () => {
    const seen: string[] = []
    const { instance, child } = supervisor({
      fetchFn: (async (_url: string, init: RequestInit) => {
        seen.push(String((init.headers as Record<string, string>).Authorization))
        return new Response("{}", { status: 200 })
      }) as unknown as typeof fetch,
    })
    const started = instance.start()
    queueMicrotask(() => child.say("opencode server listening on http://127.0.0.1:4096"))
    await started
    expect(seen[0]).toStartWith("Basic ")
    expect(seen[0]).toBe(instance.authHeader())
  })

  test("reports a missing binary instead of hanging", async () => {
    const { instance } = supervisor({ binaryMissing: true })
    const state = await instance.start()
    expect(state.phase).toMatchObject({ phase: "failed", reason: "missing-binary" })
  })

  test("reports spawn failures", async () => {
    const { instance } = supervisor({ spawnThrows: true })
    const state = await instance.start()
    expect(state.phase).toMatchObject({ phase: "failed", reason: "spawn-failed" })
  })

  test("reports a backend that dies during startup", async () => {
    const { instance, child } = supervisor()
    const started = instance.start()
    queueMicrotask(() => child.emit("exit", 1, null))
    const state = await started
    expect(state.phase).toMatchObject({ phase: "failed", reason: "exited-early" })
  })

  test("times out instead of waiting forever for a silent backend", async () => {
    const { instance } = supervisor({ startupTimeoutMs: 30 })
    const state = await instance.start()
    expect(state.phase).toMatchObject({ phase: "failed", reason: "startup-timeout" })
  })

  test("stops retrying when the backend rejects our credentials", async () => {
    let calls = 0
    const { instance, child } = supervisor({
      fetchFn: (async () => {
        calls += 1
        return new Response("", { status: 401 })
      }) as unknown as typeof fetch,
    })
    const started = instance.start()
    queueMicrotask(() => child.say("opencode server listening on http://127.0.0.1:4096"))
    const state = await started
    expect(state.phase).toMatchObject({ phase: "failed", reason: "unhealthy" })
    expect(calls).toBe(1)
  })

  test("keeps polling while the port is open but not answering yet", async () => {
    let calls = 0
    const { instance, child } = supervisor({
      fetchFn: (async () => {
        calls += 1
        if (calls < 3) throw new Error("ECONNREFUSED")
        return new Response("{}", { status: 200 })
      }) as unknown as typeof fetch,
    })
    const started = instance.start()
    queueMicrotask(() => child.say("opencode server listening on http://127.0.0.1:4096"))
    const state = await started
    expect(state.phase).toMatchObject({ phase: "ready" })
    expect(calls).toBe(3)
  })

  test("emits phase transitions to subscribers", async () => {
    const { instance, child } = supervisor()
    const phases: string[] = []
    instance.subscribe((state) => phases.push(state.phase.phase))
    const started = instance.start()
    queueMicrotask(() => child.say("opencode server listening on http://127.0.0.1:4096"))
    await started
    expect(phases).toEqual(["starting", "ready"])
  })
})

describe("BackendSupervisor shutdown", () => {
  test("terminates the process it started", async () => {
    const { instance, child } = supervisor()
    const started = instance.start()
    queueMicrotask(() => child.say("opencode server listening on http://127.0.0.1:4096"))
    await started
    await instance.stop()
    expect(child.killed).toContain("SIGTERM")
    expect(instance.current().phase).toEqual({ phase: "stopped" })
  })

  test("never kills a server the user started themselves", async () => {
    const { instance, child } = supervisor()
    instance.useExternal("http://127.0.0.1:4096")
    await instance.stop()
    expect(child.killed).toEqual([])
    expect(instance.current().phase).toEqual({ phase: "stopped" })
  })

  test("is safe to call when nothing was started", async () => {
    const { instance } = supervisor()
    await instance.stop()
    expect(instance.current().phase).toEqual({ phase: "stopped" })
  })
})

describe("BackendSupervisor credentials", () => {
  test("generates a distinct password per supervisor", () => {
    const a = supervisor().instance
    const b = supervisor().instance
    expect(a.current().credentials.password).not.toBe(b.current().credentials.password)
    expect(a.current().credentials.password.length).toBeGreaterThanOrEqual(24)
  })
})
