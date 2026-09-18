import { randomBytes } from "node:crypto"
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import {
  backendArgs,
  backendEnv,
  basicAuthHeader,
  DEFAULT_RETRY_POLICY,
  parseListeningUrl,
  type BackendPhase,
  type BackendRetryPolicy,
} from "./backend-policy"
import type { DesktopLog } from "./log"

export type BackendCredentials = { username: string; password: string }

export type BackendState = {
  phase: BackendPhase
  credentials: BackendCredentials
}

export type BackendSupervisorOptions = {
  /** Absolute path of the bundled backend executable. */
  binary: string
  /** Working directory for the child process. */
  cwd: string
  log: DesktopLog
  policy?: Partial<BackendRetryPolicy>
  /** Injected for tests. */
  spawnFn?: typeof spawn
  fetchFn?: typeof fetch
  now?: () => number
  /** Injected for tests; shutdown differs sharply between Windows and POSIX. */
  platform?: NodeJS.Platform
}

/**
 * Owns the lifecycle of the bundled backend process.
 *
 * Responsibilities:
 *  - spawn it on a loopback port with generated credentials,
 *  - wait for the listening banner, then poll `/api/health` until it answers,
 *  - surface a typed failure instead of hanging forever,
 *  - tear the process (and its children) down when the app quits.
 *
 * It never touches a server the user started themselves: `external` mode simply
 * records the URL and spawns nothing.
 */
export class BackendSupervisor {
  private child?: ChildProcess
  private state: BackendState
  private readonly policy: BackendRetryPolicy
  private readonly listeners = new Set<(state: BackendState) => void>()
  private stopping = false
  private startPromise?: Promise<BackendState>
  private readonly platform: NodeJS.Platform

  constructor(private readonly options: BackendSupervisorOptions) {
    this.policy = { ...DEFAULT_RETRY_POLICY, ...options.policy }
    this.platform = options.platform ?? process.platform
    this.state = {
      phase: { phase: "stopped" },
      credentials: { username: "opencode", password: randomBytes(24).toString("base64url") },
    }
  }

  current() {
    return this.state
  }

  /** Authorization header for the renderer's connection to the local backend. */
  authHeader() {
    return basicAuthHeader(this.state.credentials.username, this.state.credentials.password)
  }

  subscribe(listener: (state: BackendState) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(phase: BackendPhase) {
    this.state = { ...this.state, phase }
    for (const listener of this.listeners) listener(this.state)
  }

  /** Adopts a server the user runs themselves; nothing is spawned or killed. */
  useExternal(url: string) {
    this.emit({ phase: "external", url })
    return this.state
  }

  start(): Promise<BackendState> {
    if (this.startPromise) return this.startPromise
    this.startPromise = this.run().finally(() => {
      this.startPromise = undefined
    })
    return this.startPromise
  }

  private async run(): Promise<BackendState> {
    const { binary, cwd, log } = this.options
    if (!existsSync(binary)) {
      log.error(`backend binary not found at ${binary}`)
      this.emit({ phase: "failed", reason: "missing-binary", detail: binary })
      return this.state
    }

    this.stopping = false
    this.emit({ phase: "starting" })

    const spawnFn = this.options.spawnFn ?? spawn
    let child: ChildProcess
    try {
      child = spawnFn(binary, backendArgs(), {
        cwd,
        env: backendEnv(process.env, this.state.credentials.password),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        // Own the whole process group so we can take down descendants too.
        detached: this.platform !== "win32",
      })
    } catch (error) {
      log.error(`failed to spawn backend: ${String(error)}`)
      this.emit({ phase: "failed", reason: "spawn-failed", detail: String(error) })
      return this.state
    }
    this.child = child

    const url = await this.waitForListening(child)
    if (!url) return this.state

    const healthy = await this.waitForHealth(url)
    if (!healthy) return this.state

    log.info(`backend ready on ${url}`)
    this.emit({ phase: "ready", url })
    return this.state
  }

  /** Resolves with the backend origin, or undefined once a failure was emitted. */
  private waitForListening(child: ChildProcess) {
    const { log } = this.options
    const deadline = (this.options.now?.() ?? Date.now()) + this.policy.startupTimeoutMs

    return new Promise<string | undefined>((resolve) => {
      let settled = false
      const finish = (value: string | undefined) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      }

      const onLine = (raw: string) => {
        for (const line of raw.split(/\r?\n/)) {
          if (!line.trim()) continue
          // Backend output is logged through the redacting logger.
          log.info(`[backend] ${line}`)
          const url = parseListeningUrl(line)
          if (url) finish(url)
        }
      }

      child.stdout?.on("data", (chunk: Buffer) => onLine(chunk.toString()))
      child.stderr?.on("data", (chunk: Buffer) => onLine(chunk.toString()))

      child.once("error", (error) => {
        if (this.stopping) return finish(undefined)
        log.error(`backend process error: ${String(error)}`)
        this.emit({ phase: "failed", reason: "spawn-failed", detail: String(error) })
        finish(undefined)
      })

      child.once("exit", (code, signal) => {
        this.child = undefined
        if (this.stopping || settled) return finish(undefined)
        log.error(`backend exited during startup code=${code} signal=${signal}`)
        this.emit({ phase: "failed", reason: "exited-early", detail: `code=${code} signal=${signal}` })
        finish(undefined)
      })

      const remaining = Math.max(0, deadline - (this.options.now?.() ?? Date.now()))
      const timer = setTimeout(() => {
        if (this.stopping) return finish(undefined)
        log.error("backend did not report a listening port before the startup timeout")
        this.emit({ phase: "failed", reason: "startup-timeout" })
        finish(undefined)
      }, remaining)
      timer.unref?.()
    })
  }

  private async waitForHealth(url: string) {
    const fetchFn = this.options.fetchFn ?? fetch
    const now = this.options.now ?? Date.now
    const deadline = now() + this.policy.startupTimeoutMs

    while (now() < deadline) {
      if (this.stopping) return false
      try {
        const response = await fetchFn(`${url}/api/health`, {
          headers: { Authorization: this.authHeader() },
          signal: AbortSignal.timeout(2_000),
        })
        if (response.ok) return true
        // 401 means our credentials are wrong: retrying cannot fix that.
        if (response.status === 401 || response.status === 403) {
          this.options.log.error(`backend rejected the generated credentials (${response.status})`)
          this.emit({ phase: "failed", reason: "unhealthy", detail: `http ${response.status}` })
          return false
        }
      } catch {
        // Not up yet; keep polling until the deadline.
      }
      await delay(this.policy.healthIntervalMs)
    }

    if (this.stopping) return false
    this.options.log.error("backend never became healthy before the startup timeout")
    this.emit({ phase: "failed", reason: "startup-timeout" })
    return false
  }

  /**
   * Stops the backend we started. Servers adopted through `useExternal` are left
   * alone: they belong to the user, not to this app.
   */
  async stop() {
    this.stopping = true
    const child = this.child
    if (this.state.phase.phase === "external" || !child || child.exitCode !== null) {
      this.child = undefined
      this.emit({ phase: "stopped" })
      return
    }

    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
    this.killTree(child, "SIGTERM")

    const timer = setTimeout(() => this.killTree(child, "SIGKILL"), this.policy.shutdownGraceMs)
    timer.unref?.()
    await exited
    clearTimeout(timer)

    this.child = undefined
    this.options.log.info("backend stopped")
    this.emit({ phase: "stopped" })
  }

  /**
   * Kills the child and everything it spawned.
   *
   * POSIX: the child is detached into its own process group, so we signal the
   * group. If that fails (the group may already be gone) we still signal the
   * child directly, otherwise shutdown would hang waiting for an exit that
   * never comes.
   *
   * Windows: there are no process groups or signals. `child.kill()` terminates
   * only the child itself, which would strip the supervisor of any grandchild
   * the backend spawned and leave orphaned processes holding the port. So we
   * shell out to `taskkill /T` to take the whole tree down.
   */
  private killTree(child: ChildProcess, signal: NodeJS.Signals) {
    if (typeof child.pid !== "number") return

    if (this.platform === "win32") {
      this.killTreeWindows(child, signal)
      return
    }

    try {
      process.kill(-child.pid, signal)
      return
    } catch {
      // Fall through to signalling the child directly.
    }
    try {
      child.kill(signal)
    } catch {
      // Already gone.
    }
  }

  private killTreeWindows(child: ChildProcess, signal: NodeJS.Signals) {
    const spawnFn = this.options.spawnFn ?? spawn
    // SIGTERM is the graceful pass; only escalate to /F on the SIGKILL pass so
    // the backend still gets a chance to shut itself down cleanly first.
    const args = ["/PID", String(child.pid), "/T"]
    if (signal === "SIGKILL") args.push("/F")
    try {
      const killer = spawnFn("taskkill", args, { stdio: "ignore", windowsHide: true })
      killer.on?.("error", () => this.killDirect(child, signal))
    } catch {
      this.killDirect(child, signal)
    }
  }

  private killDirect(child: ChildProcess, signal: NodeJS.Signals) {
    try {
      child.kill(signal)
    } catch {
      // Already gone.
    }
  }
}

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}
