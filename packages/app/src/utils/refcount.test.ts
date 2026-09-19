import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createRefCountMap } from "./refcount"
import { pathKey } from "./path-key"

describe("createRefCountMap", () => {
  test("removes an item after its last owner is disposed", () => {
    const removed: string[] = []
    const map = createRefCountMap(
      (key) => key,
      (key) => removed.push(key),
    )
    const first = createRoot((dispose) => {
      map("/project")
      return dispose
    })
    const second = createRoot((dispose) => {
      map("/project")
      return dispose
    })

    first()
    expect(removed).toEqual([])
    second()
    expect(removed).toEqual(["/project"])
  })

  test("keeps equivalent path consumers until the last owner is disposed", () => {
    const removed: string[] = []
    const map = createRefCountMap(
      (key) => key,
      (key) => removed.push(key),
      pathKey,
    )
    const first = createRoot((dispose) => {
      map("C:\\repo")
      return dispose
    })
    const second = createRoot((dispose) => {
      map("C:/repo/")
      return dispose
    })

    first()
    expect(removed).toEqual([])
    second()
    expect(removed).toEqual(["C:/repo"])
  })

  test("counts one reference per owner, not per call", () => {
    const removed: string[] = []
    let created = 0
    const map = createRefCountMap(
      (key) => {
        created++
        return key
      },
      (key) => removed.push(key),
      pathKey,
    )
    const owner = createRoot((dispose) => {
      map("/project")
      map("/project")
      map("/project/")
      map("/project")
      return dispose
    })
    const other = createRoot((dispose) => {
      map("/project")
      return dispose
    })

    // Repeating a lookup inside one scope reuses the item instead of taking a
    // reference the scope never releases.
    expect(created).toBe(1)
    owner()
    expect(removed).toEqual([])
    other()
    expect(removed).toEqual(["/project"])
  })

  test("detains the item when no owner is available to release it", () => {
    const removed: string[] = []
    const warnings: unknown[][] = []
    const original = console.warn
    console.warn = (...args: unknown[]) => warnings.push(args)

    try {
      // The caller is a promise or an event handler: there is no reactive scope.
      const map = createRefCountMap(
        (key) => key,
        (key) => removed.push(key),
      )
      map("/project")

      const owner = createRoot((dispose) => {
        map("/project")
        return dispose
      })
      owner()

      expect(removed).toEqual([])
      expect(warnings.map(String).filter((line) => line.includes("createRoot"))).toEqual([])
    } finally {
      console.warn = original
    }
  })
})
