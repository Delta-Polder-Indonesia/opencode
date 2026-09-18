import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { backendBinaryName, backendBinaryPath } from "./paths"

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
