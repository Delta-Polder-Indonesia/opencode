import { describe, expect, test } from "bun:test"
import { allowInAppNavigation, DEFAULT_LOCAL_SERVER_URL, isLoopbackUrl, resolveLocalServerUrl } from "./config"

describe("resolveLocalServerUrl", () => {
  test("defaults to loopback", () => {
    expect(resolveLocalServerUrl({})).toBe(DEFAULT_LOCAL_SERVER_URL)
  })

  test("accepts loopback overrides", () => {
    expect(resolveLocalServerUrl({ OPENCODE_DESKTOP_SERVER_URL: "http://localhost:5000" })).toBe(
      "http://localhost:5000",
    )
    expect(resolveLocalServerUrl({ OPENCODE_DESKTOP_SERVER_URL: "http://127.0.0.1:7777/sub" })).toBe(
      "http://127.0.0.1:7777",
    )
  })

  test("refuses non-loopback and non-http overrides", () => {
    expect(resolveLocalServerUrl({ OPENCODE_DESKTOP_SERVER_URL: "http://192.168.1.10:4096" })).toBe(
      DEFAULT_LOCAL_SERVER_URL,
    )
    expect(resolveLocalServerUrl({ OPENCODE_DESKTOP_SERVER_URL: "https://example.com" })).toBe(DEFAULT_LOCAL_SERVER_URL)
    expect(resolveLocalServerUrl({ OPENCODE_DESKTOP_SERVER_URL: "garbage" })).toBe(DEFAULT_LOCAL_SERVER_URL)
  })
})

describe("isLoopbackUrl", () => {
  test("recognises loopback hosts", () => {
    expect(isLoopbackUrl("http://127.0.0.1:4096")).toBe(true)
    expect(isLoopbackUrl("http://localhost:4096")).toBe(true)
    expect(isLoopbackUrl("http://[::1]:4096")).toBe(true)
    expect(isLoopbackUrl("http://10.0.0.5:4096")).toBe(false)
  })
})

describe("allowInAppNavigation", () => {
  const policy = { rendererOrigin: "http://127.0.0.1:4455", serverOrigin: "http://127.0.0.1:4096" }

  test("allows the renderer and backend origins", () => {
    expect(allowInAppNavigation("http://127.0.0.1:4455/session", policy)).toBe(true)
    expect(allowInAppNavigation("http://127.0.0.1:4096/api/health", policy)).toBe(true)
  })

  test("blocks everything else", () => {
    expect(allowInAppNavigation("https://opencode.ai", policy)).toBe(false)
    expect(allowInAppNavigation("file:///C:/Windows/system32", policy)).toBe(false)
    expect(allowInAppNavigation("not-a-url", policy)).toBe(false)
  })

  test("allows file origin when the renderer is packaged", () => {
    const packaged = { rendererOrigin: "file://", serverOrigin: "http://127.0.0.1:4096" }
    expect(allowInAppNavigation("file:///C:/app/dist/renderer/index.html", packaged)).toBe(true)
  })
})
