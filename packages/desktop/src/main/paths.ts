import { dirname, join, resolve } from "node:path"

/**
 * Reads the CommonJS `__dirname` that the runtime actually provides.
 *
 * It has to go through `eval` because Bun's bundler substitutes any literal
 * `__dirname` token at build time with the absolute path of the *source* file.
 * `eval` runs in the enclosing scope, so it sees the real value Node/Electron
 * injects into the module wrapper instead of a string frozen at build time.
 */
function runtimeDirname(): string | undefined {
  try {
    // eslint-disable-next-line no-eval
    const value = eval("typeof __dirname !== 'undefined' ? __dirname : undefined") as unknown
    return typeof value === "string" && value ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Directory of the running main-process bundle, always absolute.
 *
 * Three things conspire here, and each one produced a different failure:
 *
 *  - A literal `__dirname` is replaced at build time with the source path, so
 *    `dist/main` resolved its siblings against `src/main` forever.
 *  - `require.main` is not populated in the Electron main process, so deriving
 *    the directory from the entry point silently fell through to the cwd and
 *    looked for the preload script beside the repository root.
 *  - Electron rejects a relative `preload` path outright, so whatever is
 *    returned must be absolute.
 *
 * So: ask the runtime for the real `__dirname`, fall back to the entry point,
 * and only then to the working directory -- resolving in every case.
 */
export function mainBundleDir(
  main: NodeJS.Module | undefined = typeof require === "undefined" ? undefined : require.main,
  cwd = process.cwd(),
  dirnameOverride: string | undefined = runtimeDirname(),
) {
  if (dirnameOverride) return resolve(cwd, dirnameOverride)
  const entry = main?.filename
  if (entry) return resolve(cwd, dirname(entry))
  return resolve(cwd)
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
