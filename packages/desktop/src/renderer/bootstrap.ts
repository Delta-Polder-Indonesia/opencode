import { ServerConnection } from "@opencode-ai/app"
import type { DesktopInfo } from "../shared/ipc"

/**
 * The desktop shell always starts against the bundled loopback backend. Remote
 * servers the user adds keep flowing through the existing server picker, so
 * remote projects continue to use the server filesystem rather than local paths.
 */
export function serverConnection(info: DesktopInfo): ServerConnection.Any {
  return {
    type: "http",
    http: { url: info.serverUrl },
  }
}

/**
 * Developer diagnostic (never user-visible copy) written when the renderer
 * bundle is loaded without the Electron preload bridge.
 */
export const MISSING_BRIDGE_DIAGNOSTIC =
  "[desktop] preload bridge unavailable; the renderer bundle only runs inside the Electron shell"
