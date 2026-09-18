# @opencode-ai/desktop

Electron shell for OpenCode. Stage 1A of the desktop IDE plan in `catatan.md`:
the application frame, the preload bridge, and the renderer entry that reuses
the existing UI from `packages/app`.

## What works today

- Electron main process with a hardened `BrowserWindow`
  (`nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`).
- A narrow, validated IPC surface (`src/shared/ipc.ts`).
- Native folder picker, application menu built from the app's shared menu
  definition, safe external link handling, and OS-located application data
  storage.
- Renderer entry that mounts the shared app UI through `PlatformProvider`.

## What is not done yet

- **Stage 1B**: the backend is _not_ started automatically and is _not_
  bundled. Start it manually while developing.
- **Stage 1D**: no installer has been produced or tested. `electron-builder.yml`
  exists as configuration only.

## Development

```sh
# terminal 1 — backend
cd packages/opencode && bun run ./src/index.ts serve --port 4096

# terminal 2 — desktop shell
cd packages/desktop && bun run dev
```

Override the backend during development with `OPENCODE_DESKTOP_SERVER_URL`
(loopback addresses only).

## Build

```sh
bun run build     # dist/main, dist/preload, dist/renderer
bun run start     # run the built shell
```

## Tests

```sh
bun test src
bun run typecheck
```

Electron is mocked in tests; the sandbox used for development cannot download
the Electron binary or open a window, so window behaviour has not been verified
at runtime.
