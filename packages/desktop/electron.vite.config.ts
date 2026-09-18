import { sentryVitePlugin } from "@sentry/vite-plugin"
import { defineConfig } from "electron-vite"
import appPlugin from "@opencode-ai/app/vite"
import * as fs from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

// The sidecar bundles `packages/opencode/src/node.ts` into `packages/opencode/dist/node`.
// Resolve against this config file's own directory so it works regardless of cwd.
const packageDir = dirname(fileURLToPath(import.meta.url))
const OPENCODE_SERVER_DIST = join(packageDir, "../opencode/dist/node")

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  if (process.env.OPENCODE_CHANNEL === "latest") return "prod"
  return "dev"
})()

const nodePtyPkg = `@lydell/node-pty-${process.platform}-${process.arch}`

const sentry =
  process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT
    ? sentryVitePlugin({
        authToken: process.env.SENTRY_AUTH_TOKEN,
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        telemetry: false,
        release: {
          name: process.env.SENTRY_RELEASE ?? process.env.VITE_SENTRY_RELEASE,
        },
        sourcemaps: {
          assets: "./out/renderer/**",
          filesToDeleteAfterUpload: "./out/renderer/**/*.map",
        },
      })
    : false

// Renderer sourcemaps are only consumed by the Sentry upload plugin above.
// Generating them for a ~2600-module bundle otherwise just wastes memory on
// local/sandbox builds (it is enough to exhaust a 4 GB builder); gate them on
// the same condition that decides whether the upload will run.
const rendererSourcemap = sentry !== false

export default defineConfig({
  main: {
    define: {
      "import.meta.env.OPENCODE_CHANNEL": JSON.stringify(channel),
    },
    build: {
      rollupOptions: {
        input: {
          index: "src/main/index.ts",
          sidecar: "src/main/sidecar.ts",
        },
        // The server is a pre-built ESM bundle (~33 MB) loaded at runtime by
        // the sidecar utility process. Keep the dynamic import external so
        // Rollup never parses its ~874k lines — re-bundling it exhausts the
        // memory budget of small builders. The runtime import is expected to
        // fail (unknown scheme) and falls back to `out/main/chunks/node.js`.
        external: ["virtual:opencode-server"],
        // Keep this identical to electron-vite's Node 20.11+ shim. Its regex insertion can
        // corrupt bundled TypeScript, while a Rollup banner places the shim safely.
        output: {
          banner: `
// -- CommonJS Shims --
import __cjs_mod__ from 'node:module';
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require = __cjs_mod__.createRequire(import.meta.url);
`,
        },
      },
      externalizeDeps: { include: [nodePtyPkg] },
    },
    plugins: [
      {
        name: "opencode:node-pty-narrower",
        enforce: "pre",
        resolveId(s) {
          if (s === "@lydell/node-pty") return nodePtyPkg
        },
      },
      {
        name: "opencode:copy-server-assets",
        async writeBundle() {
          const chunksDir = join(packageDir, "out/main/chunks")
          await fs.mkdir(chunksDir, { recursive: true })
          await fs.copyFile(join(OPENCODE_SERVER_DIST, "node.js"), join(packageDir, "out/main/chunks/node.js"))
          for (const l of await fs.readdir(OPENCODE_SERVER_DIST)) {
            if (!l.endsWith(".wasm")) continue
            await fs.copyFile(join(OPENCODE_SERVER_DIST, l), join(chunksDir, l))
          }
        },
      },
    ],
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: "src/preload/index.ts" },
        output: {
          format: "cjs",
          entryFileNames: "[name].js",
        },
      },
    },
  },
  renderer: {
    plugins: [appPlugin, sentry],
    publicDir: "../../../app/public",
    root: "src/renderer",
    build: {
      sourcemap: rendererSourcemap,
      rollupOptions: {
        input: {
          main: "src/renderer/index.html",
        },
      },
    },
  },
})
