import { describe, expect, test } from "bun:test"
import { join, relative, resolve } from "node:path"
import {
  RENDERER_ENTRY_URL,
  RENDERER_ORIGIN,
  RENDERER_SCHEME,
  RENDERER_SCHEME_PRIVILEGES,
  rendererBundleDir,
  rendererContentType,
  rendererFilePath,
} from "./renderer-protocol"

const DIR = resolve("repo", "dist", "renderer")

describe("renderer protocol", () => {
  test("entry url is the oc:// renderer origin", () => {
    expect(RENDERER_SCHEME).toBe("oc")
    expect(RENDERER_ORIGIN).toBe("oc://renderer")
    expect(RENDERER_ENTRY_URL).toBe("oc://renderer/index.html")
  })

  test("the scheme is registered as standard and secure", () => {
    // Module scripts and a working CSP 'self' need exactly these privileges.
    expect(RENDERER_SCHEME_PRIVILEGES.standard).toBe(true)
    expect(RENDERER_SCHEME_PRIVILEGES.secure).toBe(true)
    expect(RENDERER_SCHEME_PRIVILEGES.supportFetchAPI).toBe(true)
    expect(RENDERER_SCHEME_PRIVILEGES.corsEnabled).toBe(true)
  })

  test("maps the entry, assets, and the directory root to files", () => {
    expect(rendererFilePath(DIR, "oc://renderer/index.html")).toBe(join(DIR, "index.html"))
    expect(rendererFilePath(DIR, "oc://renderer/")).toBe(join(DIR, "index.html"))
    expect(rendererFilePath(DIR, "oc://renderer/assets/index-DOQZ3LKF.js")).toBe(
      join(DIR, "assets", "index-DOQZ3LKF.js"),
    )
    expect(rendererFilePath(DIR, "oc://renderer/oc-theme-preload.js")).toBe(join(DIR, "oc-theme-preload.js"))
  })

  test("ignores the query string and hash", () => {
    expect(rendererFilePath(DIR, "oc://renderer/index.html?v=1#top")).toBe(join(DIR, "index.html"))
  })

  test("rejects other schemes and hosts", () => {
    expect(rendererFilePath(DIR, "file:///etc/passwd")).toBeUndefined()
    expect(rendererFilePath(DIR, "http://renderer/index.html")).toBeUndefined()
    expect(rendererFilePath(DIR, "oc://evil/index.html")).toBeUndefined()
    expect(rendererFilePath(DIR, "not a url")).toBeUndefined()
  })

  test("never resolves outside the renderer directory", () => {
    // Plain `..` is normalized away by the URL parser itself; encoded forms
    // are decoded here and must be refused outright. Either way, a mapped file
    // always stays inside the renderer bundle.
    for (const hostile of [
      "oc://renderer/../main/index.cjs",
      "oc://renderer/%2e%2e/main/index.cjs",
      "oc://renderer/..%2fmain%2findex.cjs",
      "oc://renderer/assets/../../package.json",
      "oc://renderer/%2e%2e%2f%2e%2e%2fpackage.json",
    ]) {
      const file = rendererFilePath(DIR, hostile)
      if (file !== undefined) expect(relative(DIR, file).startsWith("..")).toBe(false)
    }
    // The WHATWG URL parser normalizes both `..` and single-encoded `%2e%2e`
    // dot segments, so hostile paths resolve to harmless nonexistent files
    // inside the bundle (served as 404); they can never climb out.
  })

  test("rejects backslashes and NUL bytes", () => {
    expect(rendererFilePath(DIR, "oc://renderer/..\\main\\index.cjs")).toBeUndefined()
    expect(rendererFilePath(DIR, "oc://renderer/index%00.html")).toBeUndefined()
  })

  test("content types cover the renderer assets", () => {
    expect(rendererContentType("index.html")).toBe("text/html")
    expect(rendererContentType("assets/index-DOQZ3LKF.js")).toBe("text/javascript")
    expect(rendererContentType("assets/index-B2xwQ59p.css")).toBe("text/css")
    expect(rendererContentType("favicon-v3.svg")).toBe("image/svg+xml")
    expect(rendererContentType("oc-theme-preload.js")).toBe("text/javascript")
    expect(rendererContentType("site.webmanifest")).toBe("application/manifest+json")
    expect(rendererContentType("unknown.bin")).toBe("application/octet-stream")
    expect(rendererContentType("noextension")).toBe("application/octet-stream")
  })

  test("renderer bundle sits beside the main bundle", () => {
    expect(rendererBundleDir(join("repo", "dist", "main"))).toBe(join("repo", "dist", "renderer"))
  })
})
