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

## Packaging (stage 1D)

```sh
bun run package:win                    # on Windows: backend -> bundles -> NSIS installer
bun run script/package.ts --dir        # unpacked app in release/, no installer
bun run script/package.ts --skip-backend --skip-bundle   # reuse staged artifacts
```

The script refuses to run off-Windows for the release target: the backend
executable is platform-specific and `script/backend.ts` cannot cross-compile,
so a cross-built installer would silently ship the wrong binary.

Notes baked into `electron-builder.yml`:

- `files` excludes `node_modules` on purpose — the bundles are self-contained
  (`dist/main` requires only `electron` and Node builtins), and electron-builder's
  dependency collector would otherwise sweep the monorepo root into the asar.
- `electronFuses` disables `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, `--inspect`,
  and extra `file://` privileges in the shipped binary.
- The installer icon (`build/icon.ico`) is generated from the project's own
  brand asset (`packages/ui/src/assets/favicon/web-app-manifest-512x512.png`).
- The backend ships as `extraResources` (outside the asar) because packed files
  cannot be spawned.

The packaged renderer is served from the `oc://renderer` scheme
(`src/main/renderer-protocol.ts`), not `file://`: the Vite entry is an ES
module and module scripts need a standard, secure origin — over `file://` the
entry is blocked and the window stays blank. `oc://renderer` is also the origin
the backend's CORS allowlist already accepts (`packages/server/src/cors.ts`).

The pipeline was validated end-to-end on Linux with a stub Electron dist
(no installer artifact, which only a Windows run can produce — see
`catatan.md`, 2026-09-19).

## What is not done yet

- **Stage 1D**: no installer artifact has been produced or tested; that requires
  running `bun run package:win` on a Windows machine.
- No Electron window has been opened at runtime yet (see Tests).

## Backend lifecycle

The shell owns the backend unless you tell it otherwise:

| Mode              | How                                      | Who owns the process                  |
| ----------------- | ---------------------------------------- | ------------------------------------- |
| Bundled (default) | stage the executable, then `bun run dev` | the app: it starts and stops it       |
| External          | set `OPENCODE_DESKTOP_SERVER_URL`        | you: the app never spawns or kills it |

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
