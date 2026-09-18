# @opencode-ai/desktop

Electron shell for OpenCode. Stages 1A and 1B of the desktop IDE plan in
`catatan.md`: the application frame, the preload bridge, the renderer entry that
reuses the existing UI from `packages/app`, and the supervised local backend.

## What works today

- Electron main process with a hardened `BrowserWindow`
  (`nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`).
- A narrow, validated IPC surface (`src/shared/ipc.ts`).
- Native folder picker, application menu built from the app's shared menu
  definition, safe external link handling, and OS-located application data
  storage.
- Renderer entry that mounts the shared app UI through `PlatformProvider`.
- **Automatic backend** (`src/main/backend.ts`): the shell spawns the bundled
  server on a loopback port with a password generated per run, waits for
  `/api/health`, and shuts it down — including child processes — on quit.

## What is not done yet

- **Stage 1D**: no installer has been produced or tested. `electron-builder.yml`
  exists as configuration only.
- No Electron window has been opened at runtime yet (see Tests).

## Backend lifecycle

The shell owns the backend unless you tell it otherwise:

| Mode              | How                                    | Who owns the process                   |
| ----------------- | -------------------------------------- | -------------------------------------- |
| Bundled (default) | stage the executable, then `bun run dev` | the app: it starts and stops it        |
| External          | set `OPENCODE_DESKTOP_SERVER_URL`      | you: the app never spawns or kills it  |

The bundled backend always binds `127.0.0.1` and is protected by a password
generated per run, passed through the environment — never through argv or a URL.
It starts with `--port 0`, so it prefers 4096 and falls back to any free port
when that one is taken.

Startup is gated: the renderer waits for the backend to become healthy, and a
failure produces a typed reason (`missing-binary`, `spawn-failed`,
`exited-early`, `startup-timeout`, `unhealthy`) instead of an indefinite hang.

## Development

```sh
# once: build the backend executable into resources/backend
cd packages/desktop && bun run script/backend.ts

# then
bun run dev
```

To use a server you run yourself instead:

```sh
cd packages/opencode && bun run ./src/index.ts serve --port 4096
cd packages/desktop && OPENCODE_DESKTOP_SERVER_URL=http://127.0.0.1:4096 bun run dev
```

Only loopback addresses are accepted.

## Build

```sh
bun run build          # dist/main, dist/preload, dist/renderer
bun run build:backend  # resources/backend/opencode[.exe]
bun run start          # run the built shell
```

## Tests

```sh
bun test src                        # unit tests (Electron is mocked)
bun run typecheck
bun run script/verify-backend.ts    # integration: real backend, real health check
```

`verify-backend.ts` spawns the staged backend for real and asserts that it binds
loopback, enforces the generated credentials, and releases its port on shutdown.

Electron itself is mocked in the unit tests; the development sandbox cannot
download the Electron binary or open a window, so window behaviour has not been
verified at runtime.
