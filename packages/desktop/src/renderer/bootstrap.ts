import { ServerConnection } from "@opencode-ai/app"
import type { BackendStatus, DesktopInfo } from "../shared/ipc"

/**
 * The desktop shell always starts against the bundled loopback backend. Remote
 * servers the user adds keep flowing through the existing server picker, so
 * remote projects continue to use the server filesystem rather than local paths.
 *
 * The bundled backend is password protected, so the connection carries the
 * generated credentials. A server the user runs themselves has no credentials
 * from us and keeps whatever auth they configured.
 */
export function serverConnection(info: DesktopInfo): ServerConnection.Any {
  return {
    type: "http",
    http: {
      url: info.serverUrl,
      ...(info.localServerAuth
        ? { username: info.localServerAuth.username, password: info.localServerAuth.password }
        : {}),
    },
  }
}

/** A backend state the renderer can connect to. */
export function backendUsable(status: BackendStatus): status is Extract<BackendStatus, { url: string }> {
  return status.status === "ready" || status.status === "external"
}

/** Terminal states: waiting longer will not help. */
export function backendSettled(status: BackendStatus) {
  return backendUsable(status) || status.status === "failed"
}

export type BackendWatcher = {
  state(): Promise<BackendStatus | undefined>
  subscribe(handler: (state: BackendStatus) => void): () => void
}

/**
 * Resolves once the backend is usable or has definitively failed. Subscribes
 * before reading the current state so a transition that lands between the two
 * is not missed.
 */
export function waitForBackend(watcher: BackendWatcher): Promise<BackendStatus> {
  return new Promise((resolve) => {
    let done = false
    const finish = (status: BackendStatus) => {
      if (done || !backendSettled(status)) return
      done = true
      unsubscribe()
      resolve(status)
    }
    const unsubscribe = watcher.subscribe(finish)
    void watcher.state().then((status) => {
      if (status) finish(status)
    })
  })
}

/**
 * Developer diagnostic (never user-visible copy) written when the renderer
 * bundle is loaded without the Electron preload bridge.
 */
export const MISSING_BRIDGE_DIAGNOSTIC =
  "[desktop] preload bridge unavailable; the renderer bundle only runs inside the Electron shell"
