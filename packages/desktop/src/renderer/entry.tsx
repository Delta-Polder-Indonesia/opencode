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

async function start() {
  const root = document.getElementById("root")
  if (!(root instanceof HTMLElement)) return

  const bridge = desktopBridge()
  if (!bridge) {
    // The renderer is only meant to run inside the Electron shell; loading it in
    // a plain browser has no preload bridge and therefore no platform APIs.
    console.error(MISSING_BRIDGE_DIAGNOSTIC)
    return
  }

  // Wait for the bundled backend before reading `info()`, so the URL and
  // credentials we hand the app are the ones it will actually connect with.
  // `AppInterface` renders its own splash while this promise is pending.
  const backend = await waitForBackend(bridge.backend)
  const info = await bridge.info()
  if (!info) {
    console.error(MISSING_BRIDGE_DIAGNOSTIC)
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

void start()
