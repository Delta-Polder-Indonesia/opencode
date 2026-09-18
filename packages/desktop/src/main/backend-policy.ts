/**
 * Pure decision logic for the backend supervisor. Kept free of Electron, Node
 * child processes, and timers so it can be unit tested directly.
 */

/** Line the backend prints once its HTTP listener is bound. */
const LISTENING_LINE = /opencode server listening on (http:\/\/[^\s]+)/i

export type BackendPhase =
  /** No backend is being managed (the user pointed us at their own server). */
  | { phase: "external"; url: string }
  /** Spawning the child process and waiting for it to report a port. */
  | { phase: "starting" }
  /** Health check passed; the renderer may connect. */
  | { phase: "ready"; url: string }
  /** Startup failed or the process died. */
  | { phase: "failed"; reason: BackendFailureReason; detail?: string }
  /** We are shutting down on purpose. */
  | { phase: "stopped" }

export type BackendFailureReason = "missing-binary" | "spawn-failed" | "exited-early" | "startup-timeout" | "unhealthy"

/**
 * Extracts the listening URL from a backend stdout line.
 * Returns undefined for any line that is not the ready banner.
 */
export function parseListeningUrl(line: string): string | undefined {
  const match = LISTENING_LINE.exec(line)
  if (!match) return undefined
  try {
    const url = new URL(match[1])
    if (url.protocol !== "http:") return undefined
    if (!url.port) return undefined
    return url.origin
  } catch {
    return undefined
  }
}

/**
 * The bundled backend must never be exposed beyond the machine: a desktop
 * backend can run shell commands, so binding it to a LAN interface would hand
 * that capability to the whole network.
 */
export const BACKEND_HOSTNAME = "127.0.0.1"

/**
 * `--port 0` lets the backend prefer 4096 and fall back to any free port, which
 * is exactly the collision behaviour we want: a second window, or a user who
 * already runs opencode on 4096, still gets a working server.
 */
export function backendArgs() {
  return ["serve", "--port", "0", "--hostname", BACKEND_HOSTNAME]
}

export type BackendRetryPolicy = {
  /** How long to wait for the listening banner and first healthy response. */
  startupTimeoutMs: number
  /** Delay between health probes while starting. */
  healthIntervalMs: number
  /** How long to wait for a graceful exit before escalating to a hard kill. */
  shutdownGraceMs: number
}

export const DEFAULT_RETRY_POLICY: BackendRetryPolicy = {
  startupTimeoutMs: 60_000,
  healthIntervalMs: 250,
  shutdownGraceMs: 5_000,
}

/**
 * Builds the child environment. The generated password is passed through the
 * environment (never argv) so it does not show up in process listings, and the
 * parent's own `OPENCODE_SERVER_PASSWORD` is not allowed to leak in and silently
 * change the credentials the renderer was handed.
 */
export function backendEnv(base: NodeJS.ProcessEnv, password: string): NodeJS.ProcessEnv {
  return {
    ...base,
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_SERVER_USERNAME: "opencode",
  }
}

/** Basic auth header value for the generated credentials. */
export function basicAuthHeader(username: string, password: string) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

/**
 * Human-readable, non-sensitive summary for the renderer's error screen.
 * Never include the password or the raw environment here.
 */
export function failureSummary(reason: BackendFailureReason): string {
  switch (reason) {
    case "missing-binary":
      return "backend.error.missingBinary"
    case "spawn-failed":
      return "backend.error.spawnFailed"
    case "exited-early":
      return "backend.error.exitedEarly"
    case "startup-timeout":
      return "backend.error.startupTimeout"
    case "unhealthy":
      return "backend.error.unhealthy"
  }
}
