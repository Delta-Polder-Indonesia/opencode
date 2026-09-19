import { describe, expect, test, mock } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { createStore } from "solid-js/store"
import type { State } from "./types"
import { applyDirectoryEvent } from "./event-reducer"

// markdown.tsx pulls Vite's `?worker&url` import, which bun test cannot
// resolve; the worker is only used for code highlighting and has a safe
// fallback, so stub the URL module before importing the component module.
mock.module("../../../../session-ui/src/components/markdown.worker.ts?worker&url", () => ({ default: "" }))
mock.module("../../../../session-ui/src/components/markdown.worker.ts?worker", () => ({ default: class {} }))

// Via the workspace specifier (like the timeline imports it): a relative
// path would drag session-ui sources into the app's TS project boundary.
const { renderable } = await import("@opencode-ai/session-ui/message-part")

/**
 * Replays the exact event sequence recorded from a real streaming turn
 * (scripted local model: reasoning deltas, then answer text deltas) and
 * asserts the app store ends up with a visible, growing answer text part.
 * This is the data path shared by the web app and the desktop shell.
 */

const baseState = (input: Partial<State> = {}) =>
  ({
    status: "complete",
    agent: [],
    command: [],
    project: "",
    projectMeta: undefined,
    icon: undefined,
    provider: {} as State["provider"],
    config: {} as State["config"],
    path: { directory: "/tmp" } as State["path"],
    session: [],
    sessionTotal: 0,
    session_status: {},
    session_diff: {},
    todo: {},
    permission: {},
    question: {},
    mcp: {},
    lsp: [],
    vcs: undefined,
    limit: 10,
    message: {},
    session_message: {},
    part: {},
    part_text_accum_delta: {},
    ...input,
  }) as State

function harness() {
  const [store, setStore] = createStore<State>(baseState())
  const apply = (event: { type: string; properties?: unknown }) =>
    applyDirectoryEvent({
      event,
      store,
      setStore,
      push: () => {},
      directory: "/tmp",
      loadLsp: () => {},
    })
  return { store, apply }
}

const assistantMessage = (completed: boolean): Message =>
  ({
    id: "msg_a",
    sessionID: "s1",
    role: "assistant",
    time: completed ? { created: 2, completed: 3 } : { created: 2 },
    providerID: "fake",
    modelID: "fake-model",
  }) as Message

const words = ["Ini ", "jawaban ", "dari ", "model ", "untuk ", "pengujian."]

describe("streaming answer turn", () => {
  test("the answer text part grows live and stays renderable until completion", () => {
    const { store, apply } = harness()
    apply({ type: "message.updated", properties: { info: assistantMessage(false) } })

    // The provider creates the text part empty, then streams word deltas.
    apply({
      type: "message.part.updated",
      properties: { part: { id: "prt_a", sessionID: "s1", messageID: "msg_a", type: "text", text: "" } as Part },
    })

    const textAt = () => (store.part["msg_a"]?.find((part) => part.id === "prt_a") as unknown as { text: string })?.text
    for (const word of words) {
      apply({
        type: "message.part.delta",
        properties: { messageID: "msg_a", partID: "prt_a", field: "text", delta: word },
      })
      // Mid-stream the part must already be renderable with visible text --
      // this is what the timeline row shows while the model is answering.
      const part = store.part["msg_a"]?.find((item) => item.id === "prt_a") as unknown as Part
      expect(renderable(part)).toBe(true)
      expect(textAt()!.length).toBeGreaterThan(0)
      expect(store.part_text_accum_delta["prt_a"]).toBeTruthy()
    }
    expect(textAt()).toBe(words.join(""))

    // The provider sends the settled snapshot (which retires the delta
    // accumulator), then the message completes.
    apply({
      type: "message.part.updated",
      properties: {
        part: { id: "prt_a", sessionID: "s1", messageID: "msg_a", type: "text", text: words.join("") } as Part,
      },
    })
    apply({ type: "message.updated", properties: { info: assistantMessage(true) } })

    const settled = store.part["msg_a"]?.find((item) => item.id === "prt_a") as unknown as Part
    expect(renderable(settled)).toBe(true)
    expect((settled as unknown as { text: string }).text).toBe(words.join(""))
  })
})
