import { beforeEach, expect, test } from "bun:test"
import { createComponent } from "solid-js"
import { render } from "solid-js/web"
import { ToastV2, toasterV2 } from "@opencode-ai/ui/v2/toast-v2"
import { resolveIcon, setV2Toast, showToast } from "../src/utils/toast"

/**
 * Regression guard for the toast icon owner.
 *
 * `showToast` runs from async flows (a resolved connect promise, an event
 * handler), where no reactive owner exists. Building `<Icon/>` there ran its
 * `onMount` as a computation no root owned: dev-solid reported "computations
 * created outside a `createRoot`" and never disposed it. `resolveIcon` now
 * returns a factory that the toast resolves while rendering, inside its own
 * scope.
 *
 * As in packages/session-ui's worker repro, bun test transpiles JSX with the
 * classic React runtime here (tsconfig `"jsx": "preserve"`, the repo builds with
 * vite-plugin-solid), so the first-render shim below maps
 * `React.createElement` onto `solid-js/web`'s `createComponent` and plain DOM.
 */
const shim = globalThis as unknown as { React?: unknown; __solidReactShim?: boolean }
if (!shim.__solidReactShim) {
  const createElement = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => {
    const flat = children.flat(Infinity).filter((child) => child !== undefined && child !== null && child !== false)
    if (typeof type === "function") {
      const next: Record<string, unknown> = { ...props }
      if (flat.length === 1) next.children = flat[0]
      else if (flat.length > 1) next.children = flat
      return createComponent(type as (props: unknown) => unknown, next)
    }
    const element = document.createElement(String(type))
    for (const [key, value] of Object.entries(props ?? {})) {
      if (value === undefined || value === null || value === false) continue
      if (key === "class" || key === "className") element.setAttribute("class", String(value))
      else if (key === "classList") {
        for (const [name, on] of Object.entries(value as Record<string, unknown>)) if (on) element.classList.add(name)
      } else if (key.startsWith("on") && typeof value === "function") {
        element.addEventListener(key.slice(2).toLowerCase(), value as EventListener)
      } else if (key === "style" && typeof value === "object") Object.assign(element.style, value)
      else element.setAttribute(key, value === true ? "" : String(value))
    }
    for (const child of flat) {
      const node = child instanceof Node ? child : document.createTextNode(String(child))
      element.appendChild(node)
    }
    return element
  }
  shim.React = { createElement, Fragment: Symbol("solid-shim-fragment") }
  shim.__solidReactShim = true
}

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 60))
}

beforeEach(() => {
  toasterV2.dismiss()
  document.querySelectorAll('[data-testid^="toast-v2-"]').forEach((element) => element.remove())
})

test("defers the toast icon instead of building it at call time", () => {
  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "))
  }

  try {
    // No owner exists here — this is what an event handler or a resolved promise
    // does — so the element must not be created yet.
    const icon = resolveIcon(undefined, "success")
    expect(typeof icon).toBe("function")

    expect(resolveIcon("circle-check", undefined)).toBeFunction()
    expect(resolveIcon(undefined, undefined)).toBeUndefined()
    expect(warnings.filter((line) => line.includes("created outside a `createRoot`"))).toEqual([])
  } finally {
    console.warn = original
  }
})

test("renders the deferred icon inside the toast it belongs to", async () => {
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(() => createComponent(ToastV2.Region, {}), host)

  try {
    setV2Toast(true)
    const id = showToast({ title: "Provider connected", variant: "success" })
    await settle()

    const toast = document.querySelector(`[data-testid="toast-v2-${id}"]`)
    expect(toast).not.toBeNull()
    expect(toast?.querySelector('[data-component="icon"]')).not.toBeNull()
  } finally {
    toasterV2.dismiss()
    dispose()
    host.remove()
  }
})
