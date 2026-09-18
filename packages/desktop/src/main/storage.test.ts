import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DesktopStorage } from "./storage"

const roots: string[] = []

function storage() {
  const root = mkdtempSync(join(tmpdir(), "opencode-desktop-storage-"))
  roots.push(root)
  return new DesktopStorage(root)
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe("DesktopStorage", () => {
  test("round-trips values per namespace", () => {
    const store = storage()
    expect(store.get("settings", "theme")).toBeNull()
    store.set("settings", "theme", "dark")
    store.set("drafts", "theme", "light")
    expect(store.get("settings", "theme")).toBe("dark")
    expect(store.get("drafts", "theme")).toBe("light")
  })

  test("removes values", () => {
    const store = storage()
    store.set("settings", "theme", "dark")
    store.remove("settings", "theme")
    expect(store.get("settings", "theme")).toBeNull()
  })

  test("persists across instances", () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-desktop-storage-"))
    roots.push(root)
    new DesktopStorage(root).set("settings", "defaultServerUrl", "http://127.0.0.1:4096/")
    expect(new DesktopStorage(root).get("settings", "defaultServerUrl")).toBe("http://127.0.0.1:4096/")
  })
})
