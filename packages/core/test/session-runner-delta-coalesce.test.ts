import { expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { LLMEvent } from "@opencode-ai/llm"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionV2 } from "@opencode-ai/core/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { createLLMEventPublisher, type PublisherOptions } from "@opencode-ai/core/session/runner/publish-llm-event"

const sessionID = SessionV2.ID.make("ses_delta_coalesce_test")

/**
 * Deterministic contract tests for streamed delta coalescing. Window flushing is driven by
 * the runner's scoped loop and exercised through `flushDeltas` directly here — no timers.
 * See specs/v2/streaming-responsiveness.md.
 */
const capture = (options?: PublisherOptions) => {
  const published: Array<{ readonly type: string; readonly data: unknown }> = []
  const events = EventV2.Service.of({
    publish: (definition, data) =>
      Effect.sync(() => {
        const event = { id: EventV2.ID.create(), type: definition.type, data } as EventV2.Payload<typeof definition>
        published.push({
          type: definition.durable
            ? EventV2.versionedType(definition.type, definition.durable.version)
            : definition.type,
          data,
        })
        return event
      }),
    subscribe: () => Stream.empty,
    all: () => Stream.empty,
    durable: () => Stream.empty,
    listen: () => Effect.succeed(Effect.void),
    project: () => Effect.void,
    replay: () => Effect.void,
    replayAll: () => Effect.succeed(undefined),
    remove: () => Effect.void,
    claim: () => Effect.void,
  })
  return {
    published,
    publisher: createLLMEventPublisher(
      events,
      {
        sessionID,
        agent: "build",
        model: {
          id: ModelV2.ID.make("model"),
          providerID: ProviderV2.ID.make("provider"),
        },
      },
      options,
    ),
  }
}

const ofType = (published: ReturnType<typeof capture>["published"], type: string) =>
  published.filter((event) => event.type === type)

const TEXT_DELTA = SessionEvent.Text.Delta.type
const REASONING_DELTA = SessionEvent.Reasoning.Delta.type
const TOOL_INPUT_DELTA = SessionEvent.Tool.Input.Delta.type

test("coalesces consecutive text deltas into one event per flush", async () => {
  const { published, publisher } = capture()
  await Effect.runPromise(publisher.publish(LLMEvent.textStart({ id: "text-1" })))
  await Effect.runPromise(publisher.publish(LLMEvent.textDelta({ id: "text-1", text: "Hello" })))
  await Effect.runPromise(publisher.publish(LLMEvent.textDelta({ id: "text-1", text: ", " })))
  await Effect.runPromise(publisher.publish(LLMEvent.textDelta({ id: "text-1", text: "world" })))

  expect(ofType(published, TEXT_DELTA)).toHaveLength(0)

  await Effect.runPromise(publisher.flushDeltas)

  const deltas = ofType(published, TEXT_DELTA)
  expect(deltas).toHaveLength(1)
  expect((deltas[0]!.data as { delta: string }).delta).toBe("Hello, world")
})

test("flushes buffered text delta before text end", async () => {
  const { published, publisher } = capture()
  await Effect.runPromise(publisher.publish(LLMEvent.textStart({ id: "text-1" })))
  await Effect.runPromise(publisher.publish(LLMEvent.textDelta({ id: "text-1", text: "Hel" })))
  await Effect.runPromise(publisher.publish(LLMEvent.textDelta({ id: "text-1", text: "lo" })))
  await Effect.runPromise(publisher.publish(LLMEvent.textEnd({ id: "text-1" })))

  const types = published.map((event) => event.type)
  const deltaIndex = types.indexOf(TEXT_DELTA)
  const endedIndex = types.indexOf(EventV2.versionedType(SessionEvent.Text.Ended.type, 1))
  expect(deltaIndex).toBeGreaterThanOrEqual(0)
  expect(deltaIndex).toBeLessThan(endedIndex)
  expect(ofType(published, TEXT_DELTA)).toHaveLength(1)
  expect((ofType(published, TEXT_DELTA)[0]!.data as { delta: string }).delta).toBe("Hello")
  expect((published[endedIndex]!.data as { text: string }).text).toBe("Hello")
})

test("flushes buffered reasoning delta before reasoning end and keeps provider metadata", async () => {
  const { published, publisher } = capture()
  const providerMetadata = { anthropic: { signature: "sig" } }
  await Effect.runPromise(publisher.publish(LLMEvent.reasoningStart({ id: "reasoning-1", providerMetadata })))
  await Effect.runPromise(publisher.publish(LLMEvent.reasoningDelta({ id: "reasoning-1", text: "Think" })))
  await Effect.runPromise(publisher.publish(LLMEvent.reasoningDelta({ id: "reasoning-1", text: " aloud" })))
  await Effect.runPromise(publisher.publish(LLMEvent.reasoningEnd({ id: "reasoning-1", providerMetadata })))

  const deltas = ofType(published, REASONING_DELTA)
  expect(deltas).toHaveLength(1)
  expect((deltas[0]!.data as { delta: string }).delta).toBe("Think aloud")
  const ended = ofType(published, EventV2.versionedType(SessionEvent.Reasoning.Ended.type, 1))
  expect(ended).toHaveLength(1)
  expect((ended[0]!.data as { text: string }).text).toBe("Think aloud")
})

test("coalesces tool input deltas and flushes before tool input end", async () => {
  const { published, publisher } = capture()
  await Effect.runPromise(publisher.publish(LLMEvent.toolInputStart({ id: "call-1", name: "write" })))
  await Effect.runPromise(
    publisher.publish(LLMEvent.toolInputDelta({ id: "call-1", name: "write", text: '{"path":"' })),
  )
  await Effect.runPromise(
    publisher.publish(LLMEvent.toolInputDelta({ id: "call-1", name: "write", text: 'README.md"}' })),
  )
  await Effect.runPromise(publisher.publish(LLMEvent.toolInputEnd({ id: "call-1", name: "write" })))

  const deltas = ofType(published, TOOL_INPUT_DELTA)
  expect(deltas).toHaveLength(1)
  expect((deltas[0]!.data as { delta: string }).delta).toBe('{"path":"README.md"}')
  const types = published.map((event) => event.type)
  expect(types.indexOf(TOOL_INPUT_DELTA)).toBeLessThan(
    types.indexOf(EventV2.versionedType(SessionEvent.Tool.Input.Ended.type, 1)),
  )
})

test("publishes immediately once buffered chars reach maxChars", async () => {
  const { published, publisher } = capture({ coalesce: { window: 50, maxChars: 8 } })
  await Effect.runPromise(publisher.publish(LLMEvent.textStart({ id: "text-1" })))
  await Effect.runPromise(publisher.publish(LLMEvent.textDelta({ id: "text-1", text: "1234" })))
  await Effect.runPromise(publisher.publish(LLMEvent.textDelta({ id: "text-1", text: "5678" })))
  await Effect.runPromise(publisher.publish(LLMEvent.textDelta({ id: "text-1", text: "9" })))

  expect(ofType(published, TEXT_DELTA)).toHaveLength(1)
  expect((ofType(published, TEXT_DELTA)[0]!.data as { delta: string }).delta).toBe("12345678")

  await Effect.runPromise(publisher.publish(LLMEvent.textEnd({ id: "text-1" })))

  const deltas = ofType(published, TEXT_DELTA)
  expect(deltas).toHaveLength(2)
  expect(deltas.map((event) => (event.data as { delta: string }).delta).join("")).toBe("123456789")
})

test("publishes deltas immediately when coalescing is disabled", async () => {
  const { published, publisher } = capture({ coalesce: false })
  await Effect.runPromise(publisher.publish(LLMEvent.textStart({ id: "text-1" })))
  await Effect.runPromise(publisher.publish(LLMEvent.textDelta({ id: "text-1", text: "a" })))
  await Effect.runPromise(publisher.publish(LLMEvent.textDelta({ id: "text-1", text: "b" })))
  await Effect.runPromise(publisher.publish(LLMEvent.textDelta({ id: "text-1", text: "c" })))
  await Effect.runPromise(publisher.publish(LLMEvent.textEnd({ id: "text-1" })))

  const deltas = ofType(published, TEXT_DELTA)
  expect(deltas).toHaveLength(3)
  expect(deltas.map((event) => (event.data as { delta: string }).delta).join("")).toBe("abc")
})

test("flushes buffered deltas on step finish settlement", async () => {
  const { published, publisher } = capture()
  await Effect.runPromise(publisher.publish(LLMEvent.textStart({ id: "text-1" })))
  await Effect.runPromise(publisher.publish(LLMEvent.textDelta({ id: "text-1", text: "Done" })))
  await Effect.runPromise(publisher.publish(LLMEvent.stepFinish({ index: 0, reason: "stop" })))

  expect(ofType(published, TEXT_DELTA)).toHaveLength(1)
  expect(ofType(published, EventV2.versionedType(SessionEvent.Text.Ended.type, 1))).toHaveLength(1)
})

test("flushes buffered deltas before failing the assistant on provider error", async () => {
  const { published, publisher } = capture()
  await Effect.runPromise(publisher.publish(LLMEvent.textStart({ id: "text-1" })))
  await Effect.runPromise(publisher.publish(LLMEvent.textDelta({ id: "text-1", text: "Partial" })))
  await Effect.runPromise(publisher.publish(LLMEvent.providerError({ message: "Provider unavailable" })))

  const types = published.map((event) => event.type)
  const deltaIndex = types.indexOf(TEXT_DELTA)
  const endedIndex = types.indexOf(EventV2.versionedType(SessionEvent.Text.Ended.type, 1))
  const failedIndex = types.indexOf(EventV2.versionedType(SessionEvent.Step.Failed.type, 2))
  expect(deltaIndex).toBeGreaterThanOrEqual(0)
  expect(endedIndex).toBeGreaterThan(deltaIndex)
  expect(failedIndex).toBeGreaterThan(endedIndex)
  expect((published[deltaIndex]!.data as { delta: string }).delta).toBe("Partial")
})

test("flush publishes remaining buffered deltas before fragment ends", async () => {
  const { published, publisher } = capture()
  await Effect.runPromise(publisher.publish(LLMEvent.textStart({ id: "text-1" })))
  await Effect.runPromise(publisher.publish(LLMEvent.textDelta({ id: "text-1", text: "First " })))
  await Effect.runPromise(publisher.publish(LLMEvent.reasoningStart({ id: "reasoning-1" })))
  await Effect.runPromise(publisher.publish(LLMEvent.reasoningDelta({ id: "reasoning-1", text: "Second" })))

  await Effect.runPromise(publisher.flush())

  expect(ofType(published, TEXT_DELTA)).toHaveLength(1)
  expect(ofType(published, REASONING_DELTA)).toHaveLength(1)
  expect((ofType(published, TEXT_DELTA)[0]!.data as { delta: string }).delta).toBe("First ")
  expect((ofType(published, REASONING_DELTA)[0]!.data as { delta: string }).delta).toBe("Second")
  // Fragment ends still publish full values for the durable read model.
  expect(
    (ofType(published, EventV2.versionedType(SessionEvent.Text.Ended.type, 1))[0]!.data as { text: string }).text,
  ).toBe("First ")
  expect(
    (ofType(published, EventV2.versionedType(SessionEvent.Reasoning.Ended.type, 1))[0]!.data as { text: string }).text,
  ).toBe("Second")
})

test("coalesces fragments independently and keeps per-fragment ordering", async () => {
  const { published, publisher } = capture()
  await Effect.runPromise(publisher.publish(LLMEvent.textStart({ id: "text-1" })))
  await Effect.runPromise(publisher.publish(LLMEvent.textDelta({ id: "text-1", text: "a1" })))
  await Effect.runPromise(publisher.publish(LLMEvent.reasoningStart({ id: "reasoning-1" })))
  await Effect.runPromise(publisher.publish(LLMEvent.reasoningDelta({ id: "reasoning-1", text: "r1" })))
  await Effect.runPromise(publisher.publish(LLMEvent.textDelta({ id: "text-1", text: "a2" })))
  await Effect.runPromise(publisher.publish(LLMEvent.reasoningDelta({ id: "reasoning-1", text: "r2" })))

  await Effect.runPromise(publisher.flushDeltas)

  expect((ofType(published, TEXT_DELTA)[0]!.data as { delta: string }).delta).toBe("a1a2")
  expect((ofType(published, REASONING_DELTA)[0]!.data as { delta: string }).delta).toBe("r1r2")
})

test("keeps delta validation when coalescing", async () => {
  const { publisher } = capture()
  await Effect.runPromise(publisher.publish(LLMEvent.stepStart({ index: 0 })))
  await expect(Effect.runPromise(publisher.publish(LLMEvent.textDelta({ id: "missing", text: "x" })))).rejects.toThrow(
    "text delta before start: missing",
  )
  await expect(
    Effect.runPromise(publisher.publish(LLMEvent.toolInputDelta({ id: "call-x", name: "read", text: "{}" }))),
  ).rejects.toThrow("Tool input delta before start: call-x")
})
