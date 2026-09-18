import { render } from "solid-js/web"
import {
  AppBaseProviders,
  AppInterface,
  loadInitialLocale,
  PlatformProvider,
  ServerConnection,
  type Platform,
} from "@opencode-ai/app"
import { createDesktopPlatform, desktopBridge } from "./platform"
import { backendUsable, MISSING_BRIDGE_DIAGNOSTIC, serverConnection, waitForBackend } from "./bootstrap"
import { describeError, renderFatal } from "./fatal"

const BACKEND_WAIT_HINT_MS = 10_000

async function start(root: HTMLElement) {
  const bridge = desktopBridge()
  if (!bridge) {
    // The renderer is only meant to run inside the Electron shell; loading it in
    // a plain browser has no preload bridge and therefore no platform APIs.
    console.error(MISSING_BRIDGE_DIAGNOSTIC)
    renderFatal(root, {
      title: "Preload bridge unavailable",
      detail: MISSING_BRIDGE_DIAGNOSTIC,
      hint: "Open this through the Electron shell (bun run dev), not directly in a browser.",
    })
    return
  }

  // Waiting on the backend can legitimately take a while, but an indefinite
  // blank window is indistinguishable from a hang, so say what we are waiting on.
  const hintTimer = setTimeout(() => {
    renderFatal(root, {
      title: "Waiting for the backend",
      detail: "The desktop shell is still waiting for the local backend to report healthy.",
      hint: "Startup gives up after 60s and shows an error. Check the main-process log for details.",
    })
  }, BACKEND_WAIT_HINT_MS)

  let backend
  let info
  try {
    // Wait for the bundled backend before reading `info()`, so the URL and
    // credentials we hand the app are the ones it will actually connect with.
    backend = await waitForBackend(bridge.backend)
    info = await bridge.info()
  } finally {
    clearTimeout(hintTimer)
  }

  if (!info) {
    // `info()` returns undefined when the main process rejects the IPC call,
    // which means the shell cannot be configured at all.
    console.error(MISSING_BRIDGE_DIAGNOSTIC)
    renderFatal(root, {
      title: "Desktop info unavailable",
      detail: "The main process did not return window configuration, so the app cannot start.",
      hint: "This usually means the IPC sender check rejected this window. See the main-process log.",
    })
    return
  }

  if (!backendUsable(backend)) {
    // The shared ErrorPage owns the user-facing copy, including the localised
    // "local server startup" description and the log export action.
    console.error(`[desktop] backend unavailable: ${backend.status}`)
  }

  const platform: Platform = createDesktopPlatform({ bridge, info })
  const server = serverConnection(info)
  const locale = await loadInitialLocale()
  const defaultServer = ServerConnection.Key.make(info.defaultServerUrl ?? info.serverUrl)

  render(
    () => (
      <PlatformProvider value={platform}>
        <AppBaseProviders
          locale={locale}
          onNativeTranslations={(bundle) => {
            void bridge.publishTranslations(JSON.parse(JSON.stringify(bundle)))
          }}
        >
          <AppInterface
            defaultServer={defaultServer}
            canonicalLocalServer={ServerConnection.key(server)}
            servers={[server]}
          />
        </AppBaseProviders>
      </PlatformProvider>
    ),
    root,
  )
}

const root = document.getElementById("root")
if (root instanceof HTMLElement) {
  // A rejection here would otherwise leave the window blank with the reason
  // only in the console, which nobody sees when devtools are closed.
  void start(root).catch((error: unknown) => {
    console.error("[desktop] renderer failed to start", error)
    renderFatal(root, {
      title: "The interface failed to start",
      detail: describeError(error),
      hint: "Copy this into a bug report. The main-process log has the backend side of the story.",
    })
  })
}
