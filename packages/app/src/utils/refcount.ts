import { getOwner, onCleanup, type Owner } from "solid-js"

/**
 * Creates a map that keeps one item per key alive while a consumer holds it.
 *
 * Consumers are counted per owner, not per call: a scope (component, memo,
 * `createRoot`) that asks for the same key twice still holds a single reference.
 * Without that, a re-running memo or an event handler that looks the same
 * directory up repeatedly would pin the item forever even after every consumer
 * is gone.
 *
 * Cleanup is only registered when there is an owner to register it on. Callers
 * without one — promises, timers, event handlers — cannot be released by
 * anything, so they detain the item for the lifetime of the map instead of
 * creating a cleanup Solid never runs; the development build warns "cleanups
 * created outside a `createRoot`" for exactly that. When such a caller has a
 * scope of its own, wrap the call in `createRoot` or `runWithOwner` so the item
 * is released with that scope.
 */
export function createRefCountMap<T>(
  create: (key: string) => T,
  remove?: (key: string) => void,
  identity: (key: string) => string = (key) => key,
) {
  const items = new Map<string, T>()
  const refCounts = new Map<string, number>()
  const detained = new Set<string>()
  const held = new WeakMap<Owner, Set<string>>()

  const release = (id: string) => {
    const count = (refCounts.get(id) ?? 0) - 1
    if (count > 0) {
      refCounts.set(id, count)
      return
    }
    refCounts.delete(id)
    // An ownerless consumer has no lifecycle to end, so the item stays for as
    // long as the map does.
    if (detained.has(id)) return
    if (!items.has(id)) return
    remove?.(id)
    items.delete(id)
  }

  return (key: string) => {
    const id = identity(key)
    const owner = getOwner()

    if (!owner) {
      detained.add(id)
    } else {
      let owned = held.get(owner)
      if (!owned) {
        owned = new Set()
        held.set(owner, owned)
      }
      if (!owned.has(id)) {
        owned.add(id)
        refCounts.set(id, (refCounts.get(id) ?? 0) + 1)
        onCleanup(() => {
          owned.delete(id)
          release(id)
        })
      }
    }

    const cached = items.get(id)
    if (cached) return cached
    const item = create(key)
    items.set(id, item)
    return item
  }
}
