/** Pure helpers for main-process configuration. Kept Electron-free for tests. */

export const DEFAULT_LOCAL_SERVER_URL = "http://127.0.0.1:4096"

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"])

/**
 * Stage 1A ships without the bundled backend supervisor (stage 1B), so the
 * local server URL is configurable through the environment for development.
 * Only loopback addresses are accepted: the desktop shell must never be pointed
 * at a LAN address by accident, because the local backend exposes shell access.
 */
export function resolveLocalServerUrl(env: Record<string, string | undefined>): string {
  const raw = env.OPENCODE_DESKTOP_SERVER_URL
  if (!raw) return DEFAULT_LOCAL_SERVER_URL
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return DEFAULT_LOCAL_SERVER_URL
  }
  if (url.protocol !== "http:") return DEFAULT_LOCAL_SERVER_URL
  if (!isLoopbackHost(url.hostname)) return DEFAULT_LOCAL_SERVER_URL
  return url.origin
}

export function isLoopbackHost(hostname: string) {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase())
}

export function isLoopbackUrl(value: string) {
  try {
    const url = new URL(value)
    return (url.protocol === "http:" || url.protocol === "https:") && isLoopbackHost(url.hostname)
  } catch {
    return false
  }
}

export type NavigationPolicyInput = {
  /** Origin the renderer document is served from. */
  rendererOrigin: string
  /** Backend origin the renderer talks to. */
  serverOrigin: string
}

/**
 * The renderer window may only ever stay on the app bundle itself. Every other
 * navigation target is handed to the OS browser (when the protocol allows it)
 * or dropped.
 */
export function allowInAppNavigation(target: string, policy: NavigationPolicyInput) {
  try {
    const url = new URL(target)
    if (url.protocol === "devtools:") return true
    // Packaged renderers are loaded over file://, where URL.origin is "null".
    if (url.protocol === "file:") return policy.rendererOrigin === "file://"
    const allowed = [policy.rendererOrigin, policy.serverOrigin]
    return allowed.includes(url.origin)
  } catch {
    return false
  }
}
