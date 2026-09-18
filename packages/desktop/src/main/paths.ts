import { dirname, join, resolve } from "node:path"

/**
 * Directory of the running main-process bundle, always absolute.
 *
 * `__dirname` cannot be used here. Bun's bundler substitutes it at build time
 * with the absolute path of the *source* file, so a bundle built in
 * `src/main/` kept resolving siblings against `src/main/` no matter where the
 * bundle actually ran from -- which meant the preload script was looked up at
 * `src/preload/index.cjs` instead of `dist/preload/index.cjs`, and would have
 * pointed outside the installation entirely in a packaged build.
 *
 * `require.main.filename` survives bundling because it is resolved at runtime,
 * and for the Electron main process it is the entry point Electron launched.
 * That entry can be whatever was on the command line, so it may be relative --
 * and Electron rejects a relative `preload` path outright. Resolving here keeps
 * that guarantee in one place instead of at each call site.
 */
export function mainBundleDir(main: NodeJS.Module | undefined = require.main, cwd = process.cwd()) {
  const entry = main?.filename
  // Electron always sets require.main for the main process; if it is somehow
  // absent, the working directory is a better guess than a stale build-time path.
  if (!entry) return resolve(cwd)
  return resolve(cwd, dirname(entry))
}

/** Executable name of the bundled backend, per platform. */
export function backendBinaryName(platform: NodeJS.Platform) {
  return platform === "win32" ? "opencode.exe" : "opencode"
}

export type BackendLocationInput = {
  platform: NodeJS.Platform
  packaged: boolean
  /** `process.resourcesPath` in a packaged app. */
  resourcesPath: string
  /** Directory of the built main process bundle (`dist/main`). */
  mainDir: string
}

/**
 * Resolves where the backend executable lives.
 *
 * Packaged builds ship it as an unpacked extra resource so it stays executable
 * (binaries inside the asar archive cannot be spawned). In development it is
 * read from `packages/desktop/resources/backend/`, which `script/backend.ts`
 * fills in.
 */
export function backendBinaryPath(input: BackendLocationInput) {
  const name = backendBinaryName(input.platform)
  if (input.packaged) return join(input.resourcesPath, "backend", name)
  return join(input.mainDir, "..", "..", "resources", "backend", name)
}
