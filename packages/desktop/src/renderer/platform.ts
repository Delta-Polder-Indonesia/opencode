import { ServerConnection, type Platform } from "@opencode-ai/app"
import type { DesktopBridge } from "../preload/index"
import type { DesktopInfo } from "../shared/ipc"

declare global {
  interface Window {
    opencodeDesktop?: DesktopBridge
  }
}

export type DesktopRuntime = {
  bridge: DesktopBridge
  info: DesktopInfo
}

/** Reads the preload bridge; absent when the renderer is loaded outside Electron. */
export function desktopBridge() {
  return typeof window === "undefined" ? undefined : window.opencodeDesktop
}

/**
 * Builds the `Platform` implementation the shared app UI consumes. The app is
 * reused as-is: only the platform capabilities differ between web and desktop.
 */
export function createDesktopPlatform(runtime: DesktopRuntime): Platform {
  const { bridge, info } = runtime
  return {
    platform: "desktop",
    os: info.os,
    version: info.version,
    windowID: info.windowID,
    openExternal: (url) => {
      void bridge.openExternal(url)
    },
    restart: async () => {
      await bridge.restart()
    },
    notify: async (title, description) => {
      await bridge.notify(title, description)
    },
    openDirectoryPickerDialog: async (opts) => bridge.openDirectoryPicker(opts),
    storage: (name) => {
      const namespace = storageNamespace(name)
      return {
        getItem: (key: string) => bridge.storage.get(namespace, key),
        setItem: (key: string, value: string) => bridge.storage.set(namespace, key, value),
        removeItem: async (key: string) => {
          await bridge.storage.remove(namespace, key)
        },
      }
    },
    getDefaultServer: async () => {
      const url = await bridge.getDefaultServer()
      return url ? ServerConnection.Key.make(url) : null
    },
    setDefaultServer: async (url) => {
      await bridge.setDefaultServer(url ? String(url) : null)
    },
    runDesktopMenuAction: async (action) => {
      await bridge.runMenuAction(action)
    },
  }
}

const NAMESPACE_PATTERN = /[^a-zA-Z0-9._-]/g

export function storageNamespace(name?: string) {
  if (!name) return "default"
  const cleaned = name.replace(NAMESPACE_PATTERN, "_").slice(0, 64)
  return cleaned || "default"
}
