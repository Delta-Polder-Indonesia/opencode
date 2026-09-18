import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  Notification,
  shell,
  type IpcMainInvokeEvent,
} from "electron"
import {
  DESKTOP_NATIVE_ENGLISH,
  parseDesktopNativeBundle,
  type DesktopNativeBundle,
  type DesktopNativeKey,
} from "@opencode-ai/app/i18n/desktop-native"
import { BackendSupervisor } from "./backend"
import { failureSummary, type BackendPhase } from "./backend-policy"
import { allowInAppNavigation, isLoopbackUrl, resolveLocalServerUrl } from "./config"
import { DesktopLog } from "./log"
import { buildMenuTemplate, menuPlatform } from "./menu"
import { backendBinaryPath } from "./paths"
import { DesktopStorage } from "./storage"
import {
  IPC,
  IPC_EVENT,
  parseDirectoryPickerRequest,
  parseExternalUrl,
  parseNotifyRequest,
  parseServerUrl,
  parseStorageGetRequest,
  parseStorageRemoveRequest,
  parseStorageSetRequest,
  parseTitlebarRequest,
  type BackendStatus,
  type DesktopInfo,
} from "../shared/ipc"

const DEV_RENDERER_URL = process.env.OPENCODE_DESKTOP_RENDERER_URL
const IS_DEV = !app.isPackaged
/**
 * When the developer points the shell at a server they run themselves we must
 * not spawn or kill anything; the bundled supervisor is only used otherwise.
 */
const EXTERNAL_SERVER_URL = process.env.OPENCODE_DESKTOP_SERVER_URL ? resolveLocalServerUrl(process.env) : undefined
const DEFAULT_SERVER_NAMESPACE = "settings"
const DEFAULT_SERVER_KEY = "defaultServerUrl"

const log = new DesktopLog(app.getPath("logs"))
const storage = new DesktopStorage(join(app.getPath("userData"), "storage"))
const windowIDs = new WeakMap<BrowserWindow, string>()
let translations: DesktopNativeBundle | undefined

const backend = new BackendSupervisor({
  binary: backendBinaryPath({
    platform: process.platform,
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    mainDir: __dirname,
  }),
  cwd: app.getPath("userData"),
  log,
})

/** URL the renderer talks to, or undefined while the backend is still starting. */
function serverUrl() {
  const phase = backend.current().phase
  if (phase.phase === "ready" || phase.phase === "external") return phase.url
  return undefined
}

/** Origin used for navigation checks; falls back to the dev default. */
function serverOrigin() {
  return serverUrl() ?? resolveLocalServerUrl({})
}

function backendStatus(phase: BackendPhase = backend.current().phase): BackendStatus {
  switch (phase.phase) {
    case "ready":
      return { status: "ready", url: phase.url }
    case "external":
      return { status: "external", url: phase.url }
    case "starting":
      return { status: "starting" }
    case "failed":
      return { status: "failed", messageKey: failureSummary(phase.reason), detail: phase.detail }
    case "stopped":
      return { status: "stopped" }
  }
}

function broadcastBackendState() {
  const status = backendStatus()
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue
    window.webContents.send(IPC_EVENT.backendState, status)
  }
}

backend.subscribe(() => broadcastBackendState())

function t(key: DesktopNativeKey) {
  return translations?.messages[key] ?? DESKTOP_NATIVE_ENGLISH[key]
}

function rendererEntry() {
  if (IS_DEV && DEV_RENDERER_URL) return { type: "url" as const, value: DEV_RENDERER_URL }
  const file = join(__dirname, "..", "renderer", "index.html")
  return { type: "file" as const, value: file }
}

function rendererOrigin() {
  const entry = rendererEntry()
  if (entry.type === "url") return new URL(entry.value).origin
  return "file://"
}

/** Only windows this process created may call privileged IPC. */
function senderWindow(event: IpcMainInvokeEvent) {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window || window.isDestroyed()) return undefined
  if (!windowIDs.has(window)) return undefined
  const url = event.senderFrame?.url ?? ""
  if (url && !allowInAppNavigation(url, { rendererOrigin: rendererOrigin(), serverOrigin: serverOrigin() })) {
    log.warn(`rejected IPC from unexpected frame url=${url}`)
    return undefined
  }
  return window
}

function openExternal(value: string) {
  const url = parseExternalUrl(value)
  if (!url) {
    log.warn("blocked external navigation with unsupported protocol")
    return
  }
  void shell.openExternal(url)
}

function sendToFocused(channel: string, payload: string) {
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (!window || window.isDestroyed()) return
  window.webContents.send(channel, payload)
}

function runWindowAction(action: string) {
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  switch (action) {
    case "window.new":
      void createWindow()
      return
    case "window.close":
      window?.close()
      return
    case "window.minimize":
      window?.minimize()
      return
    case "window.toggleMaximize":
      if (!window) return
      if (window.isMaximized()) window.unmaximize()
      else window.maximize()
      return
    case "app.relaunch":
      app.relaunch()
      app.exit(0)
      return
    case "view.reload":
      window?.webContents.reload()
      return
    case "view.toggleDevTools":
      window?.webContents.toggleDevTools()
      return
    case "view.toggleFullscreen":
      window?.setFullScreen(!window.isFullScreen())
      return
    case "view.resetZoom":
      window?.webContents.setZoomLevel(0)
      return
    case "view.zoomIn":
      if (window) window.webContents.setZoomLevel(Math.min(window.webContents.getZoomLevel() + 0.5, 6))
      return
    case "view.zoomOut":
      if (window) window.webContents.setZoomLevel(Math.max(window.webContents.getZoomLevel() - 0.5, -6))
      return
    default:
      // Menu actions the renderer owns (edit.*, app.checkForUpdates) are pushed
      // to the window; the existing UI decides what to do with them.
      sendToFocused(IPC_EVENT.menuAction, action)
  }
}

function applyMenu() {
  const platform = menuPlatform(process.platform)
  const template = buildMenuTemplate(
    platform,
    {
      action: runWindowAction,
      command: (command) => sendToFocused(IPC_EVENT.menuCommand, command),
      link: openExternal,
    },
    translations,
  )
  Menu.setApplicationMenu(Menu.buildFromTemplate(template as Parameters<typeof Menu.buildFromTemplate>[0]))
}

async function createWindow() {
  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 720,
    minHeight: 520,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#10100e" : "#fafafa",
    autoHideMenuBar: process.platform !== "darwin",
    webPreferences: {
      preload: join(__dirname, "..", "preload", "index.cjs"),
      // Security baseline for stage 1C: no Node in the renderer, isolated
      // context, OS sandbox on, no remote module, web security enforced.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: true,
    },
  })
  windowIDs.set(window, randomUUID())

  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: "deny" }
  })

  window.webContents.on("will-navigate", (event, url) => {
    if (allowInAppNavigation(url, { rendererOrigin: rendererOrigin(), serverOrigin: serverOrigin() })) return
    event.preventDefault()
    openExternal(url)
  })

  window.webContents.on("render-process-gone", (_event, details) => {
    log.error(`renderer process gone reason=${details.reason} code=${details.exitCode ?? "n/a"}`)
  })

  window.webContents.on("did-fail-load", (_event, code, description, url) => {
    log.error(`renderer failed to load code=${code} description=${description} url=${url}`)
  })

  window.once("ready-to-show", () => window.show())

  const entry = rendererEntry()
  if (entry.type === "url") {
    log.info(`loading renderer from dev server ${entry.value}`)
    await window.loadURL(entry.value)
  } else {
    if (!existsSync(entry.value)) {
      log.error(`renderer bundle missing at ${entry.value}; run \`bun run build\` in packages/desktop`)
    }
    log.info(`loading renderer bundle ${pathToFileURL(entry.value).href}`)
    await window.loadFile(entry.value)
  }
  return window
}

function registerIpc() {
  ipcMain.handle(IPC.info, (event): DesktopInfo | undefined => {
    const window = senderWindow(event)
    if (!window) return undefined
    const stored = storage.get(DEFAULT_SERVER_NAMESPACE, DEFAULT_SERVER_KEY)
    const phase = backend.current().phase
    return {
      version: app.getVersion(),
      os: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux",
      windowID: windowIDs.get(window) ?? "",
      serverUrl: serverUrl() ?? "",
      defaultServerUrl: stored,
      // Credentials only apply to the backend this app owns; a server the user
      // runs themselves keeps whatever auth they configured.
      localServerAuth: phase.phase === "ready" ? { ...backend.current().credentials } : null,
      backend: backendStatus(phase),
    }
  })

  ipcMain.handle(IPC.backendState, (event): BackendStatus | undefined => {
    if (!senderWindow(event)) return undefined
    return backendStatus()
  })

  ipcMain.handle(IPC.backendRetry, async (event) => {
    if (!senderWindow(event)) return false
    const phase = backend.current().phase
    // Only a failed backend may be retried; never restart a healthy one or a
    // server owned by the user.
    if (phase.phase !== "failed") return false
    log.info("retrying backend startup at the user's request")
    await backend.start()
    return true
  })

  ipcMain.handle(IPC.openExternal, (event, value: unknown) => {
    if (!senderWindow(event)) return
    if (typeof value !== "string") return
    openExternal(value)
  })

  ipcMain.handle(IPC.openDirectoryPicker, async (event, raw: unknown) => {
    const window = senderWindow(event)
    if (!window) return null
    const request = parseDirectoryPickerRequest(raw)
    if (!request) return null
    const result = await dialog.showOpenDialog(window, {
      title: request.title || t("desktop.dialog.chooseFolder"),
      properties: request.multiple
        ? ["openDirectory", "createDirectory", "multiSelections"]
        : ["openDirectory", "createDirectory"],
    })
    if (result.canceled || !result.filePaths.length) return null
    return request.multiple ? result.filePaths : result.filePaths[0]
  })

  ipcMain.handle(IPC.storageGet, (event, raw: unknown) => {
    if (!senderWindow(event)) return null
    const request = parseStorageGetRequest(raw)
    if (!request) return null
    return storage.get(request.namespace, request.key)
  })

  ipcMain.handle(IPC.storageSet, (event, raw: unknown) => {
    if (!senderWindow(event)) return false
    const request = parseStorageSetRequest(raw)
    if (!request) return false
    storage.set(request.namespace, request.key, request.value)
    return true
  })

  ipcMain.handle(IPC.storageRemove, (event, raw: unknown) => {
    if (!senderWindow(event)) return false
    const request = parseStorageRemoveRequest(raw)
    if (!request) return false
    storage.remove(request.namespace, request.key)
    return true
  })

  ipcMain.handle(IPC.defaultServerGet, (event) => {
    if (!senderWindow(event)) return null
    return storage.get(DEFAULT_SERVER_NAMESPACE, DEFAULT_SERVER_KEY)
  })

  ipcMain.handle(IPC.defaultServerSet, (event, raw: unknown) => {
    if (!senderWindow(event)) return false
    const url = parseServerUrl(raw)
    if (url === undefined) return false
    if (url === null) {
      storage.remove(DEFAULT_SERVER_NAMESPACE, DEFAULT_SERVER_KEY)
      return true
    }
    storage.set(DEFAULT_SERVER_NAMESPACE, DEFAULT_SERVER_KEY, url)
    return true
  })

  ipcMain.handle(IPC.notify, (event, raw: unknown) => {
    if (!senderWindow(event)) return false
    const request = parseNotifyRequest(raw)
    if (!request || !Notification.isSupported()) return false
    const notification = new Notification({ title: request.title, body: request.description ?? "" })
    notification.on("click", () => {
      const window = BrowserWindow.getAllWindows()[0]
      window?.show()
      window?.focus()
    })
    notification.show()
    return true
  })

  ipcMain.handle(IPC.setTitlebar, (event, raw: unknown) => {
    const window = senderWindow(event)
    if (!window) return false
    const request = parseTitlebarRequest(raw)
    if (!request) return false
    window.setBackgroundColor(request.mode === "dark" ? "#10100e" : "#fafafa")
    return true
  })

  ipcMain.handle(IPC.runMenuAction, (event, raw: unknown) => {
    if (!senderWindow(event)) return false
    if (typeof raw !== "string" || raw.length > 64) return false
    runWindowAction(raw)
    return true
  })

  ipcMain.handle(IPC.publishTranslations, (event, raw: unknown) => {
    if (!senderWindow(event)) return false
    const bundle = parseDesktopNativeBundle(raw)
    if (!bundle) return false
    translations = bundle
    applyMenu()
    return true
  })

  ipcMain.handle(IPC.restart, (event) => {
    if (!senderWindow(event)) return false
    app.relaunch()
    app.exit(0)
    return true
  })
}

function main() {
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  app.on("second-instance", () => {
    const window = BrowserWindow.getAllWindows()[0]
    if (!window) {
      void createWindow()
      return
    }
    if (window.isMinimized()) window.restore()
    window.focus()
  })

  // Defence in depth: deny every permission request by default. Features that
  // need a capability must opt in explicitly in a later stage.
  app.on("web-contents-created", (_event, contents) => {
    contents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    contents.on("will-attach-webview", (event) => event.preventDefault())
  })

  app.whenReady().then(async () => {
    if (EXTERNAL_SERVER_URL && !isLoopbackUrl(EXTERNAL_SERVER_URL)) {
      log.error("configured server URL is not loopback; refusing to start")
      app.exit(1)
      return
    }
    registerIpc()
    applyMenu()

    // Show the window first so the user sees the loading state instead of an
    // empty desktop while the backend boots.
    await createWindow()

    if (EXTERNAL_SERVER_URL) {
      log.info(`using the server already running at ${EXTERNAL_SERVER_URL}; not starting a bundled backend`)
      backend.useExternal(EXTERNAL_SERVER_URL)
    } else {
      void backend.start()
    }

    app.on("activate", () => {
      if (!BrowserWindow.getAllWindows().length) void createWindow()
    })
  })

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit()
  })

  // Take the backend down with us. `before-quit` is deferred until the child has
  // actually exited so we never leave an orphaned server holding the port.
  let shuttingDown = false
  app.on("before-quit", (event) => {
    if (shuttingDown) return
    shuttingDown = true
    event.preventDefault()
    void backend
      .stop()
      .catch((error) => log.error(`failed to stop backend cleanly: ${String(error)}`))
      .finally(() => app.exit(0))
  })
}

main()
