#!/usr/bin/env bun
/**
 * Builds the desktop bundles:
 *  - main process  -> dist/main/index.cjs   (CommonJS, Electron runtime)
 *  - preload script -> dist/preload/index.cjs (CommonJS; sandboxed preloads
 *    cannot use ESM)
 *  - renderer      -> dist/renderer/*       (Vite build of the shared app UI)
 */
import { rm } from "node:fs/promises"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const dist = join(root, "dist")
const onlyNative = process.argv.includes("--native-only")

async function bundle(entry: string, outdir: string) {
  const result = await Bun.build({
    entrypoints: [join(root, entry)],
    outdir: join(dist, outdir),
    target: "node",
    format: "cjs",
    naming: "index.cjs",
    external: ["electron"],
    minify: false,
    sourcemap: "none",
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    throw new Error(`failed to bundle ${entry}`)
  }
  console.log(`built ${outdir}/index.cjs`)
}

async function renderer() {
  const proc = Bun.spawn(["bun", "x", "vite", "build", "--config", "vite.renderer.config.ts"], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  })
  const code = await proc.exited
  if (code !== 0) throw new Error(`renderer build failed with code ${code}`)
}

await rm(dist, { recursive: true, force: true })
await bundle("src/main/index.ts", "main")
await bundle("src/preload/index.ts", "preload")
if (!onlyNative) await renderer()
