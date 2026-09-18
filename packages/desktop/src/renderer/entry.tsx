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
import { MISSING_BRIDGE_DIAGNOSTIC, serverConnection } from "./bootstrap"

async function start() {
  const root = document.getElementById("root")
  if (!(root instanceof HTMLElement)) return

  const bridge = desktopBridge()
  const info = await bridge?.info()
  if (!bridge || !info) {
    // The renderer is only meant to run inside the Electron shell; loading it in
    // a plain browser has no preload bridge and therefore no platform APIs.
    console.error(MISSING_BRIDGE_DIAGNOSTIC)
    return
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
