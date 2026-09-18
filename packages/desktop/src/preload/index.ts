import { contextBridge, ipcRenderer } from "electron"
import { IPC, IPC_EVENT, type DesktopInfo } from "../shared/ipc"

/**
 * The only bridge between the sandboxed renderer and the main process.
 * It exposes a fixed, narrow set of functions; the renderer never receives
 * `ipcRenderer` itself and therefore cannot reach arbitrary channels.
 */
const bridge = {
  info: (): Promise<DesktopInfo | undefined> => ipcRenderer.invoke(IPC.info),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke(IPC.openExternal, url),
  openDirectoryPicker: (opts?: { title?: string; multiple?: boolean }): Promise<string | string[] | null> =>
    ipcRenderer.invoke(IPC.openDirectoryPicker, opts ?? {}),
  storage: {
    get: (namespace: string, key: string): Promise<string | null> =>
      ipcRenderer.invoke(IPC.storageGet, { namespace, key }),
    set: (namespace: string, key: string, value: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC.storageSet, { namespace, key, value }),
    remove: (namespace: string, key: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC.storageRemove, { namespace, key }),
  },
  getDefaultServer: (): Promise<string | null> => ipcRenderer.invoke(IPC.defaultServerGet),
  setDefaultServer: (url: string | null): Promise<boolean> => ipcRenderer.invoke(IPC.defaultServerSet, url),
  notify: (title: string, description?: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.notify, { title, description }),
  setTitlebar: (theme: { mode: "light" | "dark"; scheme?: "system" | "light" | "dark" }): Promise<boolean> =>
    ipcRenderer.invoke(IPC.setTitlebar, theme),
  runMenuAction: (action: string): Promise<boolean> => ipcRenderer.invoke(IPC.runMenuAction, action),
  publishTranslations: (bundle: unknown): Promise<boolean> => ipcRenderer.invoke(IPC.publishTranslations, bundle),
  restart: (): Promise<boolean> => ipcRenderer.invoke(IPC.restart),
  onMenuAction: (handler: (action: string) => void) => {
    const listener = (_event: unknown, action: unknown) => {
      if (typeof action === "string") handler(action)
    }
    ipcRenderer.on(IPC_EVENT.menuAction, listener)
    return () => ipcRenderer.removeListener(IPC_EVENT.menuAction, listener)
  },
  onMenuCommand: (handler: (command: string) => void) => {
    const listener = (_event: unknown, command: unknown) => {
      if (typeof command === "string") handler(command)
    }
    ipcRenderer.on(IPC_EVENT.menuCommand, listener)
    return () => ipcRenderer.removeListener(IPC_EVENT.menuCommand, listener)
  },
}

export type DesktopBridge = typeof bridge

contextBridge.exposeInMainWorld("opencodeDesktop", bridge)

// The shared app code calls `window.api?.setTitlebar`; keep that tiny surface
// working without exposing anything extra.
contextBridge.exposeInMainWorld("api", {
  setTitlebar: bridge.setTitlebar,
})
