import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"
import appPlugin from "@opencode-ai/app/vite"

const appRoot = fileURLToPath(new URL("../app", import.meta.url))

/**
 * The desktop renderer reuses the web app source tree verbatim; only the entry
 * point differs (it provides the desktop `Platform` instead of the web one).
 * Reusing `@opencode-ai/app/vite` keeps the `@/` alias, Tailwind, Solid, and the
 * theme preload transform identical between web and desktop.
 */
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  // Loaded through file:// in the packaged app, so every asset URL must be relative.
  base: "./",
  publicDir: `${appRoot}/public`,
  plugins: appPlugin as never,
  build: {
    target: "esnext",
    outDir: "dist/renderer",
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    host: "127.0.0.1",
    port: 4455,
    strictPort: true,
  },
})
