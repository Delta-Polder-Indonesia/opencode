import { join } from "node:path"

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
