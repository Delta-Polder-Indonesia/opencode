import { describe, expect, test } from "bun:test"
import { join } from "node:path"
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
})
