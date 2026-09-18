import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Namespaced key/value storage backed by JSON files under the OS application
 * data directory. The renderer only reaches this through validated IPC, so the
 * namespace and key are already restricted to a safe character set.
 */
export class DesktopStorage {
  private readonly cache = new Map<string, Record<string, string>>()

  constructor(private readonly root: string) {}

  private file(namespace: string) {
    return join(this.root, `${namespace}.json`)
  }

  private load(namespace: string) {
    const cached = this.cache.get(namespace)
    if (cached) return cached
    let data: Record<string, string> = {}
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file(namespace), "utf8"))
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === "string") data[key] = value
        }
      }
    } catch {
      data = {}
    }
    this.cache.set(namespace, data)
    return data
  }

  private flush(namespace: string) {
    const data = this.load(namespace)
    mkdirSync(this.root, { recursive: true })
    const target = this.file(namespace)
    const temp = `${target}.tmp`
    writeFileSync(temp, JSON.stringify(data), "utf8")
    renameSync(temp, target)
  }

  get(namespace: string, key: string) {
    const value = this.load(namespace)[key]
    return value === undefined ? null : value
  }

  set(namespace: string, key: string, value: string) {
    this.load(namespace)[key] = value
    this.flush(namespace)
  }

  remove(namespace: string, key: string) {
    delete this.load(namespace)[key]
    this.flush(namespace)
  }
}
