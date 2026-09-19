import { test, expect, mock } from "bun:test"

// The happy-dom registrator is a declared devDependency of this package. If
// it cannot be loaded, the checkout most likely predates a `bun install`
// after pulling this branch — fail with an actionable message instead of a
// bare "Cannot find module" when the file is loaded.
let GlobalRegistrator: typeof import("@happy-dom/global-registrator").GlobalRegistrator
try {
  GlobalRegistrator = (await import("@happy-dom/global-registrator")).GlobalRegistrator
} catch {
  throw new Error(
    [
      "Cannot load @happy-dom/global-registrator (declared devDependency of packages/session-ui).",
      "Run `bun install` at the repository root, then re-run:",
      "  cd packages/session-ui",
      "  bun test --conditions=browser src/components/markdown-worker-unavailable.repro.test.tsx",
    ].join("\n"),
  )
}

if (!(globalThis as any).__happyDomRegistered) {
  GlobalRegistrator.register()
  ;(globalThis as any).__happyDomRegistered = true
}

/**
 * REGRESSION (markdown worker unavailable).
 *
 * Pins the behavior when the markdown Web Worker is unavailable (worker
 * constructor failure — e.g. an origin/CSP rejection — or a worker that dies
 * mid-stream, e.g. a Shiki/onig WASM fault): the assistant text MUST keep
 * rendering as plain text (via the local pending-projection fallback in
 * markdown.tsx) instead of the `Markdown` component throwing and the session
 * error boundary replacing the whole session content.
 *
 * See DIAGNOSIS-markdown-worker.md for the root-cause write-up.
 *
 * Run with:
 *
 *   bun test --conditions=browser src/components/markdown-worker-unavailable.repro.test.tsx
 *
 * `--conditions=browser` selects the solid-js/web CLIENT build (bun test's
 * default "node" condition would pick the server build, whose `render` is a
 * throwing stub).
 *
 * Harness notes (why this file is shaped the way it is):
 * - The worker module state is process-global (module-level `worker`/
 *   `disabled` in markdown-worker.ts) and bun test shares one process +
 *   module registry across files, so ALL scenarios live in ONE file in a
 *   deliberate order: healthy baseline first, then failure modes that poison
 *   the state.
 * - markdown.tsx imports Vite's `?worker&url` virtual module which bun test
 *   cannot resolve (same reason
 *   packages/app/src/context/global-sync/streaming-answer.test.ts stubs it).
 * - bun test transpiles JSX with the classic React runtime
 *   (tsconfig "jsx": "preserve"), while this repo builds JSX with
 *   vite-plugin-solid (template/insert/createComponent from "solid-js/web").
 *   The shim below maps React.createElement onto solid-js/web's
 *   createComponent + plain DOM for FIRST-RENDER fidelity. That is sufficient
 *   here because Markdown manipulates its container imperatively
 *   (morphdom/updateBlock) and only its root <div> comes from JSX; the
 *   reactive behavior under test lives in signals/resources/effects, which
 *   are transform-agnostic.
 */
const { createComponent } = await import("solid-js/web")

if (!(globalThis as any).__solidReactShim) {
  const createElement = (type: any, props: any, ...children: any[]) => {
    const flat = children.flat(Infinity).filter((c: any) => c !== undefined && c !== null && c !== false)
    if (type === (globalThis as any).React.Fragment) return flat
    if (typeof type === "function") {
      const p: any = { ...props }
      if (flat.length === 1) p.children = flat[0]
      else if (flat.length > 1) p.children = flat
      return createComponent(type, p)
    }
    const el = document.createElement(type)
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v === undefined || v === null || v === false) continue
        if (k === "ref") {
          if (typeof v === "function") v(el)
          else ;(v as any).el = el
        } else if (k === "class" || k === "className") el.setAttribute("class", v)
        else if (k === "style") {
          if (typeof v === "string") el.setAttribute("style", v)
          else Object.assign((el as HTMLElement).style, v)
        } else if (k === "classList") {
          for (const [ck, cv] of Object.entries(v)) if (cv) el.classList.add(ck)
        } else if (k.startsWith("on") && typeof v === "function") {
          el.addEventListener(k[2].toLowerCase() + k.slice(3), v as EventListener)
        } else if (k.startsWith("data-") || k.startsWith("aria-") || k === "dir") el.setAttribute(k, v)
        else if (typeof (el as any)[k] !== "undefined" && k !== "value") (el as any)[k] = v
        else el.setAttribute(k, v === true ? "" : String(v))
      }
    }
    for (const child of flat) {
      if (child instanceof Node) el.appendChild(child)
      else el.appendChild(document.createTextNode(String(child)))
    }
    return el
  }
  const Fragment = Symbol("solid-shim-fragment")
  ;(globalThis as any).React = { createElement, Fragment }
  ;(globalThis as any).__solidReactShim = true
}

mock.module("./markdown.worker.ts?worker&url", () => ({
  default: "file:///C:/Program%20Files/OpenCode/app/assets/markdown.worker-B0Qqz3nX.js",
}))
// happy-dom lacks enough DOM for DOMPurify (isSupported === false would blank
// every parsed block); the sanitizer is orthogonal to the worker failure.
mock.module("dompurify", () => ({
  default: { isSupported: true, sanitize: (html: string) => html, addHook: () => {} },
}))

import { project, type Projection } from "./markdown-stream"
const { render, ErrorBoundary } = await import("solid-js/web")
const { createSignal } = await import("solid-js")
const { Markdown } = await import("./markdown")

type ProtocolMessage = {
  type: string
  id?: number
  key?: string
  text?: string
  live?: boolean
  language?: string
  complete?: boolean
}

/**
 * In-thread fake speaking the real markdown worker protocol (see
 * markdown-worker-protocol.ts), so markdown-worker.ts + the Solid resources +
 * DOM update logic all run for real.
 */
class FakeWorker {
  static instances: FakeWorker[] = []
  static projections = new Map<string, Projection>()
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: { message?: string }) => void) | null = null
  onmessageerror: (() => void) | null = null
  constructor(public url: string, public options?: { type?: string }) {
    FakeWorker.instances.push(this)
  }
  postMessage(request: ProtocolMessage) {
    queueMicrotask(() => this.handle(request))
  }
  private escape(text: string) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>")
  }
  private handle(request: ProtocolMessage) {
    if (this.onmessage === null) return
    switch (request.type) {
      case "project": {
        const projection = project(FakeWorker.projections.get(request.key!), request.text!, request.live!)
        FakeWorker.projections.set(request.key!, projection)
        this.onmessage({ data: { type: "project", id: request.id, key: request.key, projection } })
        return
      }
      case "parse":
        this.onmessage({ data: { type: "parse", id: request.id, html: `<p>${this.escape(request.text!)}</p>` } })
        return
      case "highlight":
        this.onmessage({
          data: {
            type: "highlight",
            id: request.id,
            key: request.key,
            language: request.language!,
            reset: true,
            stable: [[request.text!, "color: red;"]] as unknown as [string, string][],
            unstable: [],
          },
        })
        return
      case "dispose":
        FakeWorker.projections.delete(request.key!)
        return
    }
  }
  terminate() {
    this.onmessage = null
    this.onerror = null
    this.onmessageerror = null
  }
}

function throwingWorker(message: string) {
  return class {
    constructor() {
      throw new Error(message)
    }
  }
}

async function waitFor(fn: () => boolean, timeoutMs = 4000, label = "condition") {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fn()) return true
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/**
 * Mounts Markdown the way Solid's own JSX transform emits it: dynamic props
 * as GETTERS on the props object (`get text() { return text(); }`), so the
 * component's reads stay tracked and reactive (the classic React transform
 * bun test uses would evaluate them eagerly once and break reactivity).
 */
function mountMarkdown(
  host: HTMLElement,
  source: { cacheKey: string; streaming?: boolean | (() => boolean); text?: string | (() => string) },
) {
  const props: Record<string, unknown> = { cacheKey: source.cacheKey }
  if (typeof source.streaming === "function") {
    const get = source.streaming
    Object.defineProperty(props, "streaming", { enumerable: true, get })
  } else {
    props.streaming = source.streaming
  }
  if (typeof source.text === "function") {
    const get = source.text
    Object.defineProperty(props, "text", { enumerable: true, get })
  } else {
    props.text = source.text
  }
  render(() => createComponent(Markdown, props as any), host)
  return props
}

const CSP_FILE_WORKER_ERROR =
  "Failed to construct 'Worker': Script at 'file:///C:/Program Files/OpenCode/app/assets/markdown.worker-B0Qqz3nX.js' cannot be loaded from an origin of 'null'."

;(globalThis as any).Worker = FakeWorker

/* ------------------------------------------------------------------ *
 * 1. Baseline: healthy worker — behavior the fix MUST preserve.
 * ------------------------------------------------------------------ */

test("BASELINE: streamed text is visible from the first delta and settles to parsed HTML", async () => {
  const [text, setText] = createSignal("")
  const host = document.createElement("div")
  document.body.appendChild(host)

  mountMarkdown(host, { cacheKey: "prt_base_1", streaming: true, text: () => text() })
  expect(FakeWorker.instances.length).toBe(1)

  setText("Halo, ini ")
  await waitFor(() => (host.textContent ?? "").includes("Halo, ini "), 4000, "first delta to appear")

  setText("Halo, ini jawaban ")
  await waitFor(() => (host.textContent ?? "").includes("jawaban "), 4000, "second delta to appear")

  setText("Halo, ini jawaban lengkap.")
  await waitFor(
    () => host.querySelector("p") !== null && (host.textContent ?? "").includes("Halo, ini jawaban lengkap."),
    4000,
    "parsed <p> block to appear",
  )
  expect(host.innerHTML).not.toBe("")
})

test("BASELINE: completion (streaming -> false) keeps the full text", async () => {
  const [text, setText] = createSignal("Awal jawaban")
  const [streaming, setStreaming] = createSignal(true)
  const host = document.createElement("div")
  document.body.appendChild(host)

  mountMarkdown(host, { cacheKey: "prt_base_2", streaming: () => streaming(), text: () => text() })
  await waitFor(() => (host.textContent ?? "").includes("Awal jawaban"), 4000, "initial text")

  setText("Awal jawaban berlanjut sampai akhir.")
  await waitFor(() => (host.textContent ?? "").includes("berlanjut sampai akhir."), 4000, "extended text")

  setStreaming(false)
  await waitFor(
    () => (host.textContent ?? "").includes("Awal jawaban berlanjut sampai akhir."),
    4000,
    "settled text after completion",
  )
  expect((host.textContent ?? "").trim().length).toBeGreaterThan(0)
})

/* ------------------------------------------------------------------ *
 * 2. REGRESSION: worker dies mid-stream (any environment) — the text
 *    must keep rendering as plain text, not die.
 * ------------------------------------------------------------------ */

test("REGRESSION: worker crash mid-stream -> text keeps rendering (plain) during streaming and after completion", async () => {
  const [text, setText] = createSignal("Halo, ")
  const [streaming, setStreaming] = createSignal(true)
  const host = document.createElement("div")
  document.body.appendChild(host)

  mountMarkdown(host, { cacheKey: "fix_crash_1", streaming: () => streaming(), text: () => text() })
  await waitFor(() => (host.textContent ?? "").includes("Halo, "), 4000, "initial text")

  // The worker dies mid-stream (simulates e.g. a Shiki/onig WASM fault).
  // (The module caches a single Worker instance; the one with a live
  // onmessage handler is the one markdown-worker.ts is currently using.)
  const liveWorker = FakeWorker.instances.find((w) => w.onmessage !== null)
  expect(liveWorker).toBeDefined()
  liveWorker!.onerror?.({ message: "simulated worker crash: onig wasm failure" })

  // Next delta: the projection resource errors, but Markdown must fall back
  // to the local pending projection (plain text) instead of throwing.
  let updateError: unknown
  try {
    setText("Halo, ini jawaban lengkap.")
  } catch (e) {
    updateError = e
  }
  expect(updateError).toBeUndefined()
  await waitFor(
    () => (host.textContent ?? "").includes("Halo, ini jawaban lengkap."),
    4000,
    "full text to keep rendering after the crash",
  )

  // Completion (streaming -> false) keeps the full text.
  setStreaming(false)
  await waitFor(
    () => (host.textContent ?? "").includes("Halo, ini jawaban lengkap."),
    4000,
    "full text after completion",
  )
  expect((host.textContent ?? "").trim().length).toBeGreaterThan(0)
})

test("REGRESSION: after a crash, mounting another streaming part still renders the text (plain)", async () => {
  const second = document.createElement("div")
  document.body.appendChild(second)
  let error: unknown
  try {
    mountMarkdown(second, { cacheKey: "fix_crash_2", streaming: true, text: "bagian berikutnya" })
  } catch (e) {
    error = e
  }
  await waitFor(() => (second.textContent ?? "").includes("bagian berikutnya"), 4000, "text on fresh mount after crash")
  expect(error).toBeUndefined()
})

/* ------------------------------------------------------------------ *
 * 3. REGRESSION: worker constructor throws from the start — the
 *    packaged-desktop origin/CSP situation.
 * ------------------------------------------------------------------ */

test("REGRESSION: worker constructor failure -> fresh streaming mount still renders the text (plain)", async () => {
  const real = globalThis.Worker
  // Deterministically put the module-level worker state into the dead
  // condition the packaged app faces on first mount: if a live worker is
  // still cached from earlier tests, crash it (that runs the module's
  // `fail()` -> sets `disabled`); then make any re-creation throw like a
  // CSP/"null origin" rejection would.
  const live = FakeWorker.instances.find((w) => w.onmessage !== null)
  if (live) live.onerror?.({ message: CSP_FILE_WORKER_ERROR })
  globalThis.Worker = throwingWorker(CSP_FILE_WORKER_ERROR) as never
  try {
    const host = document.createElement("div")
    document.body.appendChild(host)

    let error: unknown
    try {
      mountMarkdown(host, { cacheKey: "fix_csp_1", streaming: true, text: "Halo" })
    } catch (e) {
      error = e
    }

    // The projection resource errors, and the html loader's parse attempt
    // rejects; the component must settle on the escaped plain-text fallback
    // instead of throwing at mount.
    //
    // (If the worker was already poisoned by the earlier crash tests, the
    // same error comes from the `disabled` branch of getWorker — either way
    // Markdown must render the text; this test guards the fresh-mount case
    // when run in a clean process.)
    expect(error).toBeUndefined()
    await waitFor(() => (host.textContent ?? "").includes("Halo"), 4000, "plain-text fallback on fresh mount")
    expect(host.querySelector('[data-component="markdown"]')).not.toBeNull()
  } finally {
    globalThis.Worker = real as never
  }
})

test("REGRESSION: with an ErrorBoundary (like the session route), the content stays — no fallback needed", async () => {
  const host = document.createElement("div")
  document.body.appendChild(host)

  // Mirrors Solid's compiled output for <ErrorBoundary>{...}</ErrorBoundary>:
  // `children` is a GETTER whose body creates the child tree, so the children
  // are instantiated while the boundary's catchError error scope is active
  // (bun test's classic React transform would evaluate children eagerly,
  // i.e. BEFORE the boundary exists, and a throw would escape it).
  const mdProps: Record<string, unknown> = { cacheKey: "fix_csp_2", streaming: true, text: "Halo" }
  let fallbackError: unknown
  const boundaryProps: Record<string, unknown> = {
    fallback: (error: Error) => {
      fallbackError = error
      const el = document.createElement("div")
      el.setAttribute("data-repro", "error-fallback")
      el.textContent = "SESSION-FALLBACK"
      return el
    },
  }
  Object.defineProperty(boundaryProps, "children", {
    enumerable: true,
    get: () => {
      const el = document.createElement("div")
      el.setAttribute("data-repro", "session-content")
      el.appendChild(createComponent(Markdown, mdProps as any) as unknown as Node)
      return [el]
    },
  })

  render(() => createComponent(ErrorBoundary, boundaryProps as any), host)

  // The worker failure no longer escapes Markdown: the session content is
  // intact and shows the answer text (plain, unhighlighted) — no fallback.
  await waitFor(
    () => (host.querySelector("[data-repro='session-content']")?.textContent ?? "").includes("Halo"),
    4000,
    "session content to keep the text",
  )
  expect(host.querySelector("[data-repro='error-fallback']")).toBeNull()
  expect(fallbackError).toBeUndefined()
})

/* ------------------------------------------------------------------ *
 * 4. CONTROL: the non-streaming path survives the same failure —
 *    the asymmetry that proves where the text is lost.
 * ------------------------------------------------------------------ */

test("CONTROL: non-streaming Markdown still renders (escaped plain text) when the worker is unavailable", async () => {
  const host = document.createElement("div")
  document.body.appendChild(host)

  let error: unknown
  try {
    mountMarkdown(host, { cacheKey: "prt_static_1", streaming: false, text: "Halo dari jawaban statis" })
  } catch (e) {
    error = e
  }
  await new Promise((resolve) => setTimeout(resolve, 100))

  // Static markdown never loads the `projection` resource (its source
  // returns undefined when !streaming && !streamed), and its html loader
  // catches the parse failure -> fallback escaped text. Tool outputs /
  // reloaded history therefore stay visible while streamed answers die.
  expect(error).toBeUndefined()
  expect(host.textContent ?? "").toContain("Halo dari jawaban statis")
})
