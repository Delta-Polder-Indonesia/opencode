#!/usr/bin/env bun
/**
 * Stages the backend executable that the desktop shell spawns.
 *
 * The backend is built by `packages/opencode/script/build.ts`, which uses
 * `bun build --compile` to produce a self-contained executable. That is what
 * lets the desktop app run without the user installing Bun.
 *
 * Usage:
 *   bun run script/backend.ts            # build for the current platform
 *   bun run script/backend.ts --target windows-x64
 *   bun run script/backend.ts --from <path-to-existing-binary>
 */
import { chmod, cp, mkdir, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"

const root = join(import.meta.dir, "..")
const repo = join(root, "..", "..")
const opencodeDir = join(repo, "packages", "opencode")
const outDir = join(root, "resources", "backend")

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    target: { type: "string" },
    from: { type: "string" },
  },
})

function binaryName(target: string) {
  return target.startsWith("windows") ? "opencode.exe" : "opencode"
}

function currentTarget() {
  const os = process.platform === "win32" ? "windows" : process.platform
  return `${os}-${process.arch}`
}

const target = values.target ?? currentTarget()
const name = binaryName(target)

await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })

if (values.from) {
  if (!existsSync(values.from)) throw new Error(`backend binary not found: ${values.from}`)
  await cp(values.from, join(outDir, name))
  await chmod(join(outDir, name), 0o755)
  console.log(`staged backend from ${values.from}`)
  process.exit(0)
}

console.log(`building backend for ${target} (this compiles the opencode CLI, it takes a while)`)
const build = Bun.spawn(["bun", "run", "script/build.ts", "--single", "--skip-embed-web-ui"], {
  cwd: opencodeDir,
  stdout: "inherit",
  stderr: "inherit",
})
if ((await build.exited) !== 0) throw new Error("backend build failed")

// `build.ts` writes dist/opencode-<os>-<arch>/bin/opencode
const built = join(opencodeDir, "dist", `opencode-${target}`, "bin", name)
if (!existsSync(built)) {
  throw new Error(
    `expected the backend build to produce ${built}. ` +
      `Pass --from <path> if your build wrote the executable somewhere else.`,
  )
}

await cp(built, join(outDir, name))
await chmod(join(outDir, name), 0o755)
console.log(`staged backend at ${join(outDir, name)}`)
