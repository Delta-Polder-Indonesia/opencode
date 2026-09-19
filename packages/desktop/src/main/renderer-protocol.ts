/**
 * Loading the packaged renderer.
 *
 * The production renderer is a Vite build whose entry is an ES module script.
 * Module scripts require CORS, and `file://` pages have an opaque origin
 * ("null"), so loading `dist/renderer/index.html` over `file://` blocks the
 * entry script outright -- the window stays blank with no UI process alive to
 * report why. The development path never hit this because the renderer came
 * from the Vite HTTP server.
 *
 * So the renderer is served from a custom standard scheme instead:
 * `oc://renderer/index.html`, resolved against the renderer bundle directory
 * (inside the asar in a packaged app). `oc://renderer` is also the exact origin
 * the backend's CORS allowlist already accepts for the desktop renderer
 * (`packages/server/src/cors.ts`), so API calls from the UI pass without any
 * backend change.
 */

import { isAbsolute, join, relative, resolve } from "node:path"

export const RENDERER_SCHEME = "oc"
export const RENDERER_HOST = "renderer"
export const RENDERER_ORIGIN = `${RENDERER_SCHEME}://${RENDERER_HOST}`
export const RENDERER_ENTRY_URL = `${RENDERER_ORIGIN}/index.html`

/**
 * A standard, secure, CORS-capable scheme: that is what makes module scripts,
 * relative asset resolution, and a sane CSP `'self'` work, and what makes the
 * browser engine send `Origin: oc://renderer` to the backend.
 */
export const RENDERER_SCHEME_PRIVILEGES = {
  standard: true,
  secure: true,
  supportFetchAPI: true,
  corsEnabled: true,
  stream: true,
} as const

/**
 * Maps a renderer URL to a file inside `rendererDir`, or undefined for
 * anything this protocol must not serve: other schemes or hosts, path
 * traversal (plain or percent-encoded), backslashes, and NUL bytes.
 */
export function rendererFilePath(rendererDir: string, rawUrl: string): string | undefined {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return undefined
  }
  if (url.protocol !== `${RENDERER_SCHEME}:` || url.hostname !== RENDERER_HOST) return undefined
  let pathname: string
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return undefined
  }
  if (pathname.includes("\0") || pathname.includes("\\")) return undefined
  if (pathname.endsWith("/")) pathname += "index.html"
  const target = resolve(rendererDir, `.${pathname}`)
  const rel = relative(rendererDir, target)
  if (rel.startsWith("..") || isAbsolute(rel)) return undefined
  return target
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".cjs": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".txt": "text/plain",
}

/** Content type for a renderer asset; octet-stream for anything unknown. */
export function rendererContentType(filePath: string): string {
  const dot = filePath.lastIndexOf(".")
  if (dot < 0) return "application/octet-stream"
  return CONTENT_TYPES[filePath.slice(dot).toLowerCase()] ?? "application/octet-stream"
}

/** The directory of the renderer bundle, relative to the main bundle. */
export function rendererBundleDir(mainDir: string) {
  return join(mainDir, "..", "renderer")
}
