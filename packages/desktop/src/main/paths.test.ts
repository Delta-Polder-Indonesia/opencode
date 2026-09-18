import { describe, expect, test } from "bun:test"
import { isAbsolute, join } from "node:path"
import { backendBinaryName, backendBinaryPath, mainBundleDir } from "./paths"

describe("backendBinaryName", () => {
  test("uses the .exe suffix on Windows only", () => {
    expect(backendBinaryName("win32")).toBe("opencode.exe")
    expect(backendBinaryName("linux")).toBe("opencode")
    expect(backendBinaryName("darwin")).toBe("opencode")
  })
})

describe("backendBinaryPath", () => {
  test("reads from unpacked resources in a packaged app", () => {
    const path = backendBinaryPath({
      platform: "win32",
      packaged: true,
      resourcesPath: join("C:", "Program Files", "OpenCode", "resources"),
      mainDir: join("C:", "app", "dist", "main"),
    })
    expect(path).toBe(join("C:", "Program Files", "OpenCode", "resources", "backend", "opencode.exe"))
  })

  test("reads from the package resources directory in development", () => {
    const path = backendBinaryPath({
      platform: "linux",
      packaged: false,
      resourcesPath: "/unused",
      mainDir: join("/repo", "packages", "desktop", "dist", "main"),
    })
    expect(path).toBe(join("/repo", "packages", "desktop", "resources", "backend", "opencode"))
  })

  test("never resolves inside the asar archive", () => {
    const path = backendBinaryPath({
      platform: "win32",
      packaged: true,
      resourcesPath: join("C:", "app", "resources"),
      mainDir: join("C:", "app", "resources", "app.asar", "dist", "main"),
    })
    expect(path).not.toContain("app.asar")
  })
})

// Bun inlines `__dirname` as the absolute path of the source file at build
// time, so using it here resolved sibling bundles against `src/main/` forever:
// the preload script was looked up at `src/preload/index.cjs` rather than
// `dist/preload/index.cjs`, and in a packaged app it pointed outside the
// installation entirely. These pin the runtime behaviour.
describe("mainBundleDir", () => {
  test("follows the entry point wherever the bundle actually runs", () => {
    const dir = mainBundleDir({
      filename: join("/opt", "OpenCode", "app", "dist", "main", "index.cjs"),
    } as NodeJS.Module)
    expect(dir).toBe(join("/opt", "OpenCode", "app", "dist", "main"))
  })

  test("locates the preload bundle next to the main bundle, not next to the source", () => {
    const dir = mainBundleDir({ filename: join("/opt", "app", "dist", "main", "index.cjs") } as NodeJS.Module)
    expect(join(dir, "..", "preload", "index.cjs")).toBe(join("/opt", "app", "dist", "preload", "index.cjs"))
  })

  test("falls back to the working directory when there is no entry point", () => {
    expect(mainBundleDir(undefined)).toBe(process.cwd())
  })

  // Electron rejects a relative preload path outright ("preload script must
  // have absolute path"), and the entry point is whatever was on the command
  // line -- `electron dist/main/index.cjs` yields a relative filename.
  test("returns an absolute path even when launched with a relative entry", () => {
    const dir = mainBundleDir(
      { filename: join("dist", "main", "index.cjs") } as NodeJS.Module,
      join("/srv", "app"),
      undefined,
    )
    expect(dir).toBe(join("/srv", "app", "dist", "main"))
    expect(isAbsolute(dir)).toBe(true)
  })

  test("leaves an already absolute entry untouched", () => {
    const entry = join("/opt", "OpenCode", "dist", "main", "index.cjs")
    expect(mainBundleDir({ filename: entry } as NodeJS.Module, join("/somewhere", "else"), undefined)).toBe(
      join("/opt", "OpenCode", "dist", "main"),
    )
  })

  // Electron does not populate require.main in the main process. Without a
  // runtime __dirname that fell through to the cwd, which put the preload
  // lookup beside the repository root instead of beside the bundle.
  test("prefers the runtime directory over the entry point", () => {
    const dir = mainBundleDir(
      { filename: join("/wrong", "place", "index.cjs") } as NodeJS.Module,
      join("/srv", "app"),
      join("/opt", "OpenCode", "dist", "main"),
    )
    expect(dir).toBe(join("/opt", "OpenCode", "dist", "main"))
  })

  test("uses the runtime directory when there is no entry point at all", () => {
    const dir = mainBundleDir(
      undefined,
      join("/repo", "packages", "desktop"),
      join("/repo", "packages", "desktop", "dist", "main"),
    )
    expect(dir).toBe(join("/repo", "packages", "desktop", "dist", "main"))
    // The bug produced /repo/packages/preload/index.cjs; guard against it.
    expect(join(dir, "..", "preload", "index.cjs")).toBe(
      join("/repo", "packages", "desktop", "dist", "preload", "index.cjs"),
    )
  })

  test("resolves a relative runtime directory against the cwd", () => {
    const dir = mainBundleDir(undefined, join("/srv", "app"), join("dist", "main"))
    expect(dir).toBe(join("/srv", "app", "dist", "main"))
    expect(isAbsolute(dir)).toBe(true)
  })
})
