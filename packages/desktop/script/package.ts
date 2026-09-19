#!/usr/bin/env bun
/**
 * Stage 1D: produce a distributable desktop package.
 *
 * The release path is a Windows x64 NSIS installer and it must be run ON
 * Windows: the backend executable cannot be cross-compiled (see
 * script/backend.ts), and an installer that ships a Linux backend inside a
 * Windows shell would be silently broken.
 *
 *   bun run package:win                    # backend -> bundles -> installer
 *   bun run script/package.ts --skip-backend   # reuse resources/backend
 *   bun run script/package.ts --skip-bundle    # reuse dist/
 *   bun run script/package.ts --dir            # unpacked app, no installer
 *   bun run script/package.ts --linux          # pipeline smoke test (linux)
 *
 * Everything the builder needs is verified before it starts: a staged backend
 * binary, the desktop bundles, and the installer icon.
 */
import { existsSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"

const root = join(import.meta.dir, "..")

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "skip-backend": { type: "boolean", default: false },
    "skip-bundle": { type: "boolean", default: false },
    dir: { type: "boolean", default: false },
    linux: { type: "boolean", default: false },
  },
})

/** The installer is Windows-only; --linux exists to smoke-test the pipeline. */
const target = values.linux ? "linux" : "win"
const binaryName = target === "win" ? "opencode.exe" : "opencode"
const staged = join(root, "resources", "backend", binaryName)

if (target === "win" && process.platform !== "win32") {
  console.error(`[package] the Windows installer must be built on Windows.`)
  console.error(
    `[package] the backend executable is platform-specific and this script ` +
      `refuses to package one that does not match the installer. ` +
      `Run \`bun run package:win\` in PowerShell on the Windows machine.`,
  )
  process.exit(1)
}

async function run(step: string, command: string[], cwd = root) {
  console.log(`[package] ${step}`)
  const proc = Bun.spawn(command, { cwd, stdout: "inherit", stderr: "inherit" })
  if ((await proc.exited) !== 0) {
    console.error(`[package] ${step} failed with code ${proc.exitCode}`)
    process.exit(proc.exitCode ?? 1)
  }
}

if (!values["skip-backend"]) {
  await run("building the backend executable (this takes a while)", ["bun", "run", "script/backend.ts"])
}
if (!existsSync(staged)) {
  console.error(`[package] no backend executable at ${staged}`)
  console.error(
    `[package] remove --skip-backend to build one, or stage an existing ` +
      `binary with \`bun run script/backend.ts --from <path>\`.`,
  )
  process.exit(1)
}

if (!values["skip-bundle"]) {
  await run("bundling main, preload, and renderer", ["bun", "run", "script/build.ts"])
}
for (const bundle of ["dist/main/index.cjs", "dist/preload/index.cjs", "dist/renderer/index.html"]) {
  if (!existsSync(join(root, bundle))) {
    console.error(`[package] missing ${bundle}; remove --skip-bundle to rebuild`)
    process.exit(1)
  }
}

const icon = join(root, "build", target === "win" ? "icon.ico" : "icon.png")
if (!existsSync(icon)) {
  console.error(`[package] missing ${icon}; electron-builder would fall back to the Electron default`)
  process.exit(1)
}

// `--publish never` keeps a CI token from turning a local build into a release;
// publishing is a separate, explicit process.
const builderArgs = ["bun", "x", "electron-builder", "--publish", "never"]
if (target === "win") builderArgs.push("--win", "--x64")
else builderArgs.push("--linux")
if (values.dir) builderArgs.push("--dir")

await run("electron-builder", builderArgs)
console.log(`[package] done; see ${join(root, "release")} for the artifacts`)
