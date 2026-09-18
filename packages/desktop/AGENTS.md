## Scope

`packages/desktop` is the Electron shell around the existing web app. It owns
the main process, the preload bridge, and a thin renderer entry point. It must
never fork or duplicate the UI: everything visible comes from
`packages/app` through `PlatformProvider`.

## Security rules

- `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`,
  `webviewTag: false`. Never relax these to make a feature work.
- The preload exposes one frozen object through `contextBridge`. Never hand
  `ipcRenderer`, `require`, or Node primitives to the renderer.
- Every IPC handler must validate its sender (`senderWindow`) and its payload
  with a parser from `src/shared/ipc.ts`. Unknown or malformed input returns a
  safe default; it never throws into the renderer.
- The local backend URL must stay loopback. Remote servers are reached through
  the app's existing server connection flow, not by repointing the shell.
- External links are limited to `http:`, `https:`, and `mailto:`.
- Never log tokens, passwords, or API keys; `src/main/log.ts` redacts them.

## Backend lifecycle

- The app owns only the backend it spawned. A server adopted through
  `OPENCODE_DESKTOP_SERVER_URL` must never be killed, restarted, or reconfigured.
- The bundled backend binds loopback only and authenticates with a password
  generated per run. Never pass that password through argv, a URL, or a log line.
- Never assume a port. Read the port the backend reports on stdout; it starts
  with `--port 0` precisely so a busy 4096 is not fatal.
- Every startup path must terminate: success, a typed failure, or the timeout.
  Do not add a code path that can wait forever.
- On quit, wait for the child to actually exit before the process ends, so no
  orphaned server keeps holding the port.

## Platform parity

- Remote projects must keep using the server filesystem. The native folder
  picker only runs when `directoryPickerKind()` in `packages/app` returns
  `"native"`, which requires a local connection.
- Menus come from `@opencode-ai/app/desktop-menu`; do not invent a second menu
  definition. Labels come from the `DESKTOP_NATIVE_*` dictionaries in
  `packages/app/src/i18n/desktop-native.ts`.
- Do not hardcode user-visible English strings here. Use the desktop native
  i18n keys.

## Development

- `bun run dev` starts the Vite renderer dev server on `127.0.0.1:4455`, builds
  the main/preload bundles, then launches Electron.
- Run the backend separately from `packages/opencode`:
  `bun run ./src/index.ts serve --port 4096`.
- `bun run build` produces `dist/main`, `dist/preload`, and `dist/renderer`.
- `bun test src` runs the unit tests. Electron itself is mocked; anything that
  needs a real Electron runtime must be verified manually on a machine with a
  display and noted as such.
