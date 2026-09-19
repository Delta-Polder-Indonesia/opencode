import { afterEach, describe, expect, test } from "bun:test"
import { ensureDirectory } from "@opencode-ai/server/location"
import { Effect } from "effect"
import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances } from "../fixture/fixture"

// A path that is guaranteed not to exist: the parent is a fresh temp directory
// we never create a child in.
async function missingDirectory() {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-location-"))
  return { parent, directory: path.join(parent, "gone") }
}

function request(route: string, directory: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set("x-opencode-directory", directory)
  return Server.Default().app.request(route, { ...init, headers })
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("location directory that cannot be resolved", () => {
  test("answers the reference endpoint with 404 instead of 500", async () => {
    const { parent, directory } = await missingDirectory()
    try {
      const response = await request("/api/reference", directory)
      expect(response.status).not.toBe(500)
      expect(response.status).toBe(404)
      expect(await response.json()).toMatchObject({
        _tag: "LocationNotFoundError",
        directory,
      })
    } finally {
      await fs.rm(parent, { recursive: true, force: true })
    }
  })

  test("keeps the reference endpoint at 200 for a valid directory", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-location-"))
    try {
      const response = await request("/api/reference", directory)
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ location: { directory }, data: [] })
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  test("applies to every location-scoped endpoint, not just reference", async () => {
    const { parent, directory } = await missingDirectory()
    try {
      const routes = ["/api/fs/list", "/api/location", "/api/agent", "/api/command", "/api/skill", "/api/pty"]
      const statuses = await Promise.all(routes.map(async (route) => (await request(route, directory)).status))
      expect(statuses).toEqual(routes.map(() => 404))
    } finally {
      await fs.rm(parent, { recursive: true, force: true })
    }
  })

  // `/path` (the route the diagnostics logged as `/api/path`) belongs to the
  // instance group: it resolves through the workspace routing context instead of
  // the location middleware, so it answers with the instance it can resolve. It
  // must still not die on a directory it cannot resolve.
  test("instance routes answer instead of dying on an unresolvable directory", async () => {
    const { parent, directory } = await missingDirectory()
    try {
      const response = await request("/path", directory)
      expect(response.status).not.toBe(500)
    } finally {
      await fs.rm(parent, { recursive: true, force: true })
    }
  })

  test("session endpoints report a vanished workspace as 404, not 500", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-location-"))
    const created = await request("/api/session", directory, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ location: { directory } }),
    })
    expect(created.status).toBe(200)
    const sessionID = ((await created.json()) as { data: { id: string } }).data.id

    const before = await request(`/api/session/${sessionID}/history`, directory)
    expect(before.status).toBe(200)

    await fs.rm(directory, { recursive: true, force: true })

    const after = await request(`/api/session/${sessionID}/history`, directory)
    expect(after.status).not.toBe(500)
    expect(after.status).toBe(404)
    expect(await after.json()).toMatchObject({ _tag: "LocationNotFoundError" })
  })

  test("ensureDirectory fails typed for a path whose parent is a file", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-location-"))
    try {
      const file = path.join(parent, "file.txt")
      await Bun.write(file, "not a directory")

      const error = await Effect.runPromise(Effect.flip(ensureDirectory(path.join(file, "child"))))
      expect(error._tag).toBe("LocationNotFoundError")

      await Effect.runPromise(ensureDirectory(parent))
    } finally {
      await fs.rm(parent, { recursive: true, force: true })
    }
  })
})
