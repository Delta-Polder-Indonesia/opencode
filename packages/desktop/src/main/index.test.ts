import { beforeAll, describe, expect, mock, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { IPC } from "../shared/ipc"

/**
 * Smoke test for the main process wiring. Electron itself cannot run in CI
 * sandboxes without a display (and its binary is not downloadable here), so the
 * module is mocked to assert the security posture and the IPC validation that
 * the real process depends on.
 */

type Handler = (event: unknown, ...args: unknown[]) => unknown

const handlers = new Map<string, Handler>()
const windows: Array<{ options: Record<string, any>; webContents: any }> = []
const externalOpens: string[] = []
const dataDir = mkdtempSync(join(tmpdir(), "opencode-desktop-main-"))

let readyResolve: () => void
const ready = new Promise<void>((resolve) => (readyResolve = resolve))

class FakeWebContents {
  listeners = new Map<string, Function>()
  session = { setPermissionRequestHandler: () => {} }
  windowOpenHandler?: (details: { url: string }) => unknown
  on(event: string, handler: Function) {
    this.listeners.set(event, handler)
  }
  setWindowOpenHandler(handler: (details: { url: string }) => unknown) {
    this.windowOpenHandler = handler
  }
  send() {}
  setZoomLevel() {}
  getZoomLevel() {
    return 0
  }
}

class FakeBrowserWindow {
  static instances: FakeBrowserWindow[] = []
  webContents = new FakeWebContents()
  destroyed = false
  constructor(public options: Record<string, any>) {
    FakeBrowserWindow.instances.push(this)
    windows.push({ options, webContents: this.webContents })
  }
  static fromWebContents(contents: unknown) {
    return FakeBrowserWindow.instances.find((window) => window.webContents === contents)
  }
  static getAllWindows() {
    return FakeBrowserWindow.instances
  }
  static getFocusedWindow() {
    return FakeBrowserWindow.instances[0]
  }
  isDestroyed() {
    return this.destroyed
  }
  once(event: string, handler: Function) {
    if (event === "ready-to-show") handler()
  }
  on() {}
  show() {}
  focus() {}
  isMinimized() {
    return false
  }
  restore() {}
  setBackgroundColor() {}
  async loadURL() {}
  async loadFile() {}
}

beforeAll(async () => {
  // Development mode: the renderer is served by the Vite dev server, so frames
  // from that loopback origin are the legitimate senders.
  process.env.OPENCODE_DESKTOP_RENDERER_URL = "http://127.0.0.1:4455"

  mock.module("electron", () => ({
    app: {
      isPackaged: false,
      getVersion: () => "1.18.31",
      getPath: (name: string) => join(dataDir, name),
      requestSingleInstanceLock: () => true,
      on: () => {},
      whenReady: () => ready,
      relaunch: () => {},
      exit: () => {},
      quit: () => {},
    },
    BrowserWindow: FakeBrowserWindow,
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ["/home/user/project"] }) },
    ipcMain: {
      handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    },
    Menu: { buildFromTemplate: (template: unknown) => template, setApplicationMenu: () => {} },
    nativeTheme: { shouldUseDarkColors: false },
    Notification: Object.assign(
      class {
        on() {}
        show() {}
      },
      { isSupported: () => false },
    ),
    shell: {
      openExternal: async (url: string) => {
        externalOpens.push(url)
      },
    },
  }))

  await import("./index")
  readyResolve!()
  // Let app.whenReady().then(...) finish creating the first window.
  await new Promise((resolve) => setTimeout(resolve, 50))
})

function call(channel: string, ...args: unknown[]) {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`no handler registered for ${channel}`)
  const window = FakeBrowserWindow.instances[0]
  return handler({ sender: window.webContents, senderFrame: { url: "http://127.0.0.1:4455/" } }, ...args)
}

describe("main window security", () => {
  test("creates a window with the hardened web preferences", () => {
    expect(windows.length).toBe(1)
    const prefs = windows[0].options.webPreferences
    expect(prefs.nodeIntegration).toBe(false)
    expect(prefs.contextIsolation).toBe(true)
    expect(prefs.sandbox).toBe(true)
    expect(prefs.webviewTag).toBe(false)
    expect(prefs.webSecurity).toBe(true)
    expect(prefs.allowRunningInsecureContent).toBe(false)
    expect(String(prefs.preload)).toContain(join("preload", "index.cjs"))
  })

  test("denies renderer-initiated window opens and routes safe links outside", () => {
    const handler = FakeBrowserWindow.instances[0].webContents.windowOpenHandler!
    expect(handler({ url: "https://opencode.ai/docs" })).toEqual({ action: "deny" })
    expect(externalOpens).toContain("https://opencode.ai/docs")
    const before = externalOpens.length
    handler({ url: "file:///etc/passwd" })
    expect(externalOpens.length).toBe(before)
  })
})

describe("main ipc handlers", () => {
  test("registers exactly the documented channels", () => {
    expect(new Set(handlers.keys())).toEqual(new Set(Object.values(IPC)))
  })

  test("rejects IPC from frames outside the app", () => {
    const handler = handlers.get(IPC.info)!
    const result = handler({
      sender: FakeBrowserWindow.instances[0].webContents,
      senderFrame: { url: "https://evil.example.com/" },
    })
    expect(result).toBeUndefined()
  })

  test("rejects IPC from unknown web contents", () => {
    const handler = handlers.get(IPC.info)!
    expect(handler({ sender: {}, senderFrame: { url: "http://127.0.0.1:4455/" } })).toBeUndefined()
  })

  test("reports desktop info with a loopback server url", () => {
    const info = call(IPC.info) as { serverUrl: string; windowID: string; version: string }
    expect(info.serverUrl).toBe("http://127.0.0.1:4096")
    expect(info.version).toBe("1.18.31")
    expect(info.windowID.length).toBeGreaterThan(0)
  })

  test("persists only valid default server urls", () => {
    expect(call(IPC.defaultServerSet, "ftp://example.com")).toBe(false)
    expect(call(IPC.defaultServerSet, "https://team.example.com")).toBe(true)
    expect(call(IPC.defaultServerGet)).toBe("https://team.example.com/")
    expect(call(IPC.defaultServerSet, null)).toBe(true)
    expect(call(IPC.defaultServerGet)).toBeNull()
  })

  test("validates storage writes", () => {
    expect(call(IPC.storageSet, { namespace: "../escape", key: "a", value: "b" })).toBe(false)
    expect(call(IPC.storageSet, { namespace: "settings", key: "theme", value: "dark" })).toBe(true)
    expect(call(IPC.storageGet, { namespace: "settings", key: "theme" })).toBe("dark")
    expect(call(IPC.storageRemove, { namespace: "settings", key: "theme" })).toBe(true)
    expect(call(IPC.storageGet, { namespace: "settings", key: "theme" })).toBeNull()
  })

  test("returns the selected directory from the native picker", async () => {
    await expect(call(IPC.openDirectoryPicker, { title: "Open" })).resolves.toBe("/home/user/project")
    await expect(call(IPC.openDirectoryPicker, { multiple: "nope" })).resolves.toBeNull()
  })

  test("ignores unsupported external protocols", () => {
    const before = externalOpens.length
    call(IPC.openExternal, "javascript:alert(1)")
    expect(externalOpens.length).toBe(before)
    call(IPC.openExternal, "https://opencode.ai/")
    expect(externalOpens.at(-1)).toBe("https://opencode.ai/")
  })

  test("rejects malformed titlebar and menu payloads", () => {
    expect(call(IPC.setTitlebar, { mode: "sepia" })).toBe(false)
    expect(call(IPC.setTitlebar, { mode: "dark" })).toBe(true)
    expect(call(IPC.runMenuAction, 42)).toBe(false)
    expect(call(IPC.runMenuAction, "view.resetZoom")).toBe(true)
  })

  test("only accepts well-formed translation bundles", () => {
    expect(call(IPC.publishTranslations, { locale: "id", messages: { "desktop.menu.file": "Berkas" } })).toBe(false)
    expect(call(IPC.publishTranslations, "nope")).toBe(false)
  })
})
