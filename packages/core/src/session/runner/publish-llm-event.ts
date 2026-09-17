import { ToolOutput, type LLMEvent, type ProviderMetadata, type ToolResultValue, type Usage } from "@opencode-ai/llm"
import { DateTime, Duration, Effect } from "effect"
import { EventV2 } from "../../event"
import { ModelV2 } from "../../model"
import { SessionEvent } from "../event"
import { SessionMessage } from "../message"
import { SessionSchema } from "../schema"

type Input = {
  readonly sessionID: SessionSchema.ID
  readonly agent: string
  readonly model: ModelV2.Ref
  readonly snapshot?: string
}

/** Tuning for live-only streamed delta coalescing. See specs/v2/streaming-responsiveness.md. */
export interface StreamDeltaCoalesce {
  /** Runner drains buffered deltas at this interval while a provider turn streams. */
  readonly window: Duration.Input
  /** Publish a fragment's buffered deltas once they reach this many characters. */
  readonly maxChars: number
}

export const STREAM_DELTA_COALESCE: StreamDeltaCoalesce = {
  window: Duration.millis(50),
  maxChars: 16 * 1024,
}

export interface PublisherOptions {
  /**
   * Merge consecutive live-only deltas per fragment into fewer events. Concatenation and
   * ordering are lossless, and buffered deltas always flush before their fragment `Ended`
   * boundary, step settlement, assistant failure, and `flush()` — so no consumer can observe
   * a delta after the message it belongs to. Pass `false` to keep the legacy 1:1 emission.
   */
  readonly coalesce?: false | StreamDeltaCoalesce
}

const safe = (value: number | undefined) => Math.max(0, Number.isFinite(value) ? (value ?? 0) : 0)

const tokens = (usage: Usage | undefined) => {
  const reasoning = safe(usage?.reasoningTokens)
  const read = safe(usage?.cacheReadInputTokens)
  const write = safe(usage?.cacheWriteInputTokens)
  return {
    input: safe(usage?.nonCachedInputTokens),
    output: safe(usage?.visibleOutputTokens),
    reasoning,
    cache: { read, write },
  }
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : { value }

const message = (value: unknown) => {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

type SettledOutput =
  | { readonly structured: Record<string, unknown>; readonly content: ToolOutput["content"] }
  | { readonly error: { readonly type: "unknown"; readonly message: string } }

const settledOutput = (value: ToolOutput | undefined, result: ToolResultValue): SettledOutput => {
  if (result.type === "error") return { error: { type: "unknown", message: message(result.value) } }
  const settled = value ?? ToolOutput.fromResultValue(result)
  if (!settled) throw new Error(`Unsupported tool result: ${message(result)}`)
  return { structured: record(settled.structured), content: settled.content }
}

/** Persist one provider turn without executing tools or starting a continuation turn. */
export const createLLMEventPublisher = (events: EventV2.Interface, input: Input, options?: PublisherOptions) => {
  const coalesce = options?.coalesce === false ? undefined : (options?.coalesce ?? STREAM_DELTA_COALESCE)
  const tools = new Map<
    string,
    {
      readonly assistantMessageID: SessionMessage.ID
      readonly name: string
      inputEnded: boolean
      called: boolean
      settled: boolean
      providerExecuted: boolean
      providerMetadata?: ProviderMetadata
    }
  >()
  const timestamp = DateTime.now
  let assistantMessageID: SessionMessage.ID | undefined
  let assistantActive = false
  let assistantFailed = false
  let providerFailed = false
  let stepSettlement: { readonly finish: string; readonly tokens: ReturnType<typeof tokens> } | undefined

  const startAssistant = Effect.fnUntraced(function* () {
    if (assistantMessageID !== undefined) return assistantMessageID
    assistantMessageID = SessionMessage.ID.create()
    assistantActive = true
    yield* events.publish(SessionEvent.Step.Started, {
      ...input,
      assistantMessageID,
      timestamp: yield* timestamp,
      snapshot: input.snapshot,
    })
    return assistantMessageID
  })
  const currentAssistantMessageID = () =>
    assistantMessageID === undefined
      ? Effect.die("Tool event before assistant step start")
      : Effect.succeed(assistantMessageID)

  const fragments = (
    name: string,
    ended: (id: string, value: string, providerMetadata?: ProviderMetadata) => Effect.Effect<void>,
  ) => {
    const chunks = new Map<string, string[]>()
    const start = (id: string) =>
      Effect.suspend(() => {
        if (chunks.has(id)) return Effect.die(`Duplicate ${name} start: ${id}`)
        chunks.set(id, [])
        return Effect.void
      })
    const append = (id: string, value: string) =>
      Effect.suspend(() => {
        const current = chunks.get(id)
        if (!current) return Effect.die(`${name} delta before start: ${id}`)
        current.push(value)
        return Effect.void
      })
    const end = Effect.fnUntraced(function* (id: string, providerMetadata?: ProviderMetadata) {
      const current = chunks.get(id)
      if (!current) return yield* Effect.die(`${name} end before start: ${id}`)
      yield* ended(id, current.join(""), providerMetadata)
      chunks.delete(id)
    })
    const flush = Effect.fnUntraced(function* () {
      for (const id of chunks.keys()) yield* end(id)
    })
    return { start, append, end, flush }
  }

  const text = fragments("text", (textID, value) =>
    Effect.gen(function* () {
      yield* events.publish(SessionEvent.Text.Ended, {
        sessionID: input.sessionID,
        assistantMessageID: yield* currentAssistantMessageID(),
        timestamp: yield* timestamp,
        textID,
        text: value,
      })
    }),
  )
  const reasoning = fragments("reasoning", (reasoningID, value, providerMetadata) =>
    Effect.gen(function* () {
      yield* events.publish(SessionEvent.Reasoning.Ended, {
        sessionID: input.sessionID,
        assistantMessageID: yield* currentAssistantMessageID(),
        timestamp: yield* timestamp,
        reasoningID,
        text: value,
        providerMetadata,
      })
    }),
  )
  const toolInput = fragments("tool input", (callID, value) =>
    Effect.gen(function* () {
      const tool = tools.get(callID)
      if (!tool) return yield* Effect.die(`Tool input end before start: ${callID}`)
      yield* events.publish(SessionEvent.Tool.Input.Ended, {
        sessionID: input.sessionID,
        timestamp: yield* timestamp,
        assistantMessageID: tool.assistantMessageID,
        callID,
        text: value,
      })
      tool.inputEnded = true
    }),
  )

  type BufferedDelta = {
    readonly publish: (delta: string) => Effect.Effect<void>
    chars: number
    parts: string[]
  }
  const deltaBuffers = new Map<string, BufferedDelta>()

  const flushDeltaBuffer = Effect.fnUntraced(function* (key: string) {
    const buffer = deltaBuffers.get(key)
    if (!buffer) return
    deltaBuffers.delete(key)
    const delta = buffer.parts.join("")
    buffer.chars = 0
    buffer.parts = []
    if (delta.length > 0) yield* buffer.publish(delta)
  })

  const flushDeltaBuffers = Effect.fn("SessionRunner.flushDeltaBuffers")(function* () {
    for (const key of Array.from(deltaBuffers.keys())) yield* flushDeltaBuffer(key)
  })()

  const bufferDelta = Effect.fnUntraced(function* (
    key: string,
    delta: string,
    publish: (delta: string) => Effect.Effect<void>,
  ) {
    let buffer = deltaBuffers.get(key)
    if (!buffer) {
      buffer = { publish, chars: 0, parts: [] }
      deltaBuffers.set(key, buffer)
    }
    buffer.parts.push(delta)
    buffer.chars += delta.length
    if (coalesce && buffer.chars >= coalesce.maxChars) yield* flushDeltaBuffer(key)
  })

  const flushFragments = Effect.fnUntraced(function* () {
    yield* text.flush()
    yield* reasoning.flush()
    yield* toolInput.flush()
  })

  const startToolInput = Effect.fnUntraced(function* (event: { readonly id: string; readonly name: string }) {
    if (tools.has(event.id)) return yield* Effect.die(`Duplicate tool input start: ${event.id}`)
    const assistantMessageID = yield* startAssistant()
    tools.set(event.id, {
      assistantMessageID,
      name: event.name,
      inputEnded: false,
      called: false,
      settled: false,
      providerExecuted: false,
    })
    yield* toolInput.start(event.id)
    yield* events.publish(SessionEvent.Tool.Input.Started, {
      sessionID: input.sessionID,
      timestamp: yield* timestamp,
      assistantMessageID,
      callID: event.id,
      name: event.name,
    })
  })

  const endToolInput = Effect.fnUntraced(function* (event: { readonly id: string; readonly name: string }) {
    const tool = tools.get(event.id)
    if (!tool) return yield* Effect.die(`Tool input end before start: ${event.id}`)
    if (tool.name !== event.name)
      return yield* Effect.die(`Tool input name changed for ${event.id}: ${tool.name} -> ${event.name}`)
    if (tool.inputEnded) return yield* Effect.die(`Duplicate tool input end: ${event.id}`)
    yield* flushDeltaBuffer(`toolInput:${event.id}`)
    yield* toolInput.end(event.id)
  })

  const flush = Effect.fn("SessionRunner.flush")(function* () {
    // Coalesced deltas must land before any fragment end published below.
    yield* flushDeltaBuffers
    yield* flushFragments()
  })

  const failAssistant = Effect.fnUntraced(function* (message: string) {
    if (assistantFailed) return
    yield* flush()
    const assistantMessageID = yield* startAssistant()
    assistantActive = false
    assistantFailed = true
    yield* events.publish(SessionEvent.Step.Failed, {
      sessionID: input.sessionID,
      timestamp: yield* timestamp,
      assistantMessageID,
      error: { type: "unknown", message },
    })
  })

  const failUnsettledTools = Effect.fn("SessionRunner.failUnsettledTools")(function* (
    message: string,
    hostedOnly = false,
  ) {
    for (const [callID, tool] of tools) {
      if (tool.settled || (hostedOnly && !tool.providerExecuted)) continue
      tool.settled = true
      yield* events.publish(SessionEvent.Tool.Failed, {
        sessionID: input.sessionID,
        timestamp: yield* timestamp,
        assistantMessageID: tool.assistantMessageID,
        callID,
        error: { type: "unknown", message },
        provider: {
          executed: tool.providerExecuted,
          ...(tool.providerMetadata === undefined ? {} : { metadata: tool.providerMetadata }),
        },
      })
    }
  })

  const assistantMessageIDForTool = (callID: string) => {
    const tool = tools.get(callID)
    return tool ? Effect.succeed(tool.assistantMessageID) : Effect.die(`Unknown tool call: ${callID}`)
  }

  const publish = Effect.fn("SessionRunner.publishLLMEvent")(function* (
    event: LLMEvent,
    outputPaths: ReadonlyArray<string> = [],
  ) {
    switch (event.type) {
      case "step-start":
        return
      case "text-start":
        yield* text.start(event.id)
        yield* events.publish(SessionEvent.Text.Started, {
          sessionID: input.sessionID,
          assistantMessageID: yield* startAssistant(),
          timestamp: yield* timestamp,
          textID: event.id,
        })
        return
      case "text-delta": {
        yield* text.append(event.id, event.text)
        const assistantMessageID = yield* currentAssistantMessageID()
        if (!coalesce) {
          yield* events.publish(SessionEvent.Text.Delta, {
            sessionID: input.sessionID,
            assistantMessageID,
            timestamp: yield* timestamp,
            textID: event.id,
            delta: event.text,
          })
          return
        }
        yield* bufferDelta(`text:${event.id}`, event.text, (delta) =>
          Effect.gen(function* () {
            yield* events.publish(SessionEvent.Text.Delta, {
              sessionID: input.sessionID,
              assistantMessageID,
              timestamp: yield* timestamp,
              textID: event.id,
              delta,
            })
          }),
        )
        return
      }
      case "text-end":
        yield* flushDeltaBuffer(`text:${event.id}`)
        yield* text.end(event.id)
        return
      case "reasoning-start":
        yield* reasoning.start(event.id)
        yield* events.publish(SessionEvent.Reasoning.Started, {
          sessionID: input.sessionID,
          assistantMessageID: yield* startAssistant(),
          timestamp: yield* timestamp,
          reasoningID: event.id,
          providerMetadata: event.providerMetadata,
        })
        return
      case "reasoning-delta": {
        yield* reasoning.append(event.id, event.text)
        const assistantMessageID = yield* currentAssistantMessageID()
        if (!coalesce) {
          yield* events.publish(SessionEvent.Reasoning.Delta, {
            sessionID: input.sessionID,
            assistantMessageID,
            timestamp: yield* timestamp,
            reasoningID: event.id,
            delta: event.text,
          })
          return
        }
        yield* bufferDelta(`reasoning:${event.id}`, event.text, (delta) =>
          Effect.gen(function* () {
            yield* events.publish(SessionEvent.Reasoning.Delta, {
              sessionID: input.sessionID,
              assistantMessageID,
              timestamp: yield* timestamp,
              reasoningID: event.id,
              delta,
            })
          }),
        )
        return
      }
      case "reasoning-end":
        yield* flushDeltaBuffer(`reasoning:${event.id}`)
        yield* reasoning.end(event.id, event.providerMetadata)
        return
      case "tool-input-start":
        yield* startToolInput(event)
        return
      case "tool-input-delta": {
        const tool = tools.get(event.id)
        if (!tool) return yield* Effect.die(`Tool input delta before start: ${event.id}`)
        if (tool.name !== event.name)
          return yield* Effect.die(`Tool input name changed for ${event.id}: ${tool.name} -> ${event.name}`)
        if (tool.inputEnded) return yield* Effect.die(`Tool input delta after end: ${event.id}`)
        yield* toolInput.append(event.id, event.text)
        if (coalesce) {
          yield* bufferDelta(`toolInput:${event.id}`, event.text, (delta) =>
            Effect.gen(function* () {
              yield* events.publish(SessionEvent.Tool.Input.Delta, {
                sessionID: input.sessionID,
                timestamp: yield* timestamp,
                assistantMessageID: tool.assistantMessageID,
                callID: event.id,
                delta,
              })
            }),
          )
          return
        }
        yield* events.publish(SessionEvent.Tool.Input.Delta, {
          sessionID: input.sessionID,
          timestamp: yield* timestamp,
          assistantMessageID: tool.assistantMessageID,
          callID: event.id,
          delta: event.text,
        })
        return
      }
      case "tool-input-end":
        yield* endToolInput(event)
        return
      case "tool-call": {
        if (!tools.has(event.id)) yield* startToolInput(event)
        const tool = tools.get(event.id)!
        if (!tool.inputEnded) yield* endToolInput(event)
        if (tool.name !== event.name)
          return yield* Effect.die(`Tool call name changed for ${event.id}: ${tool.name} -> ${event.name}`)
        if (tool.called) return yield* Effect.die(`Duplicate tool call: ${event.id}`)
        tool.called = true
        tool.providerExecuted = event.providerExecuted === true
        tool.providerMetadata = event.providerMetadata
        yield* events.publish(SessionEvent.Tool.Called, {
          sessionID: input.sessionID,
          timestamp: yield* timestamp,
          assistantMessageID: tool.assistantMessageID,
          callID: event.id,
          tool: event.name,
          input: record(event.input),
          provider: {
            executed: tool.providerExecuted,
            ...(event.providerMetadata === undefined ? {} : { metadata: event.providerMetadata }),
          },
        })
        return
      }
      case "tool-result": {
        const tool = tools.get(event.id)
        if (!tool?.called) return yield* Effect.die(`Tool result before call: ${event.id}`)
        if (tool.name !== event.name)
          return yield* Effect.die(`Tool result name changed for ${event.id}: ${tool.name} -> ${event.name}`)
        if (tool.settled) {
          if (event.result.type === "error") return
          return yield* Effect.die(`Duplicate tool result: ${event.id}`)
        }
        tool.settled = true
        const result = settledOutput(event.output, event.result)
        const provider = {
          executed: event.providerExecuted === true || tool.providerExecuted,
          ...(event.providerMetadata === undefined ? {} : { metadata: event.providerMetadata }),
        }
        if ("error" in result) {
          yield* events.publish(SessionEvent.Tool.Failed, {
            sessionID: input.sessionID,
            timestamp: yield* timestamp,
            assistantMessageID: tool.assistantMessageID,
            callID: event.id,
            error: result.error,
            result: event.result,
            provider,
          })
          return
        }
        yield* events.publish(SessionEvent.Tool.Success, {
          sessionID: input.sessionID,
          timestamp: yield* timestamp,
          assistantMessageID: tool.assistantMessageID,
          callID: event.id,
          ...result,
          outputPaths,
          ...(provider.executed ? { result: event.result } : {}),
          provider,
        })
        return
      }
      case "tool-error": {
        const tool = tools.get(event.id)
        if (!tool?.called) return yield* Effect.die(`Tool error before call: ${event.id}`)
        if (tool.name !== event.name)
          return yield* Effect.die(`Tool error name changed for ${event.id}: ${tool.name} -> ${event.name}`)
        if (tool.settled) return yield* Effect.die(`Duplicate tool error: ${event.id}`)
        tool.settled = true
        yield* events.publish(SessionEvent.Tool.Failed, {
          sessionID: input.sessionID,
          timestamp: yield* timestamp,
          assistantMessageID: tool.assistantMessageID,
          callID: event.id,
          error: { type: "unknown", message: event.message },
          provider: {
            executed: tool.providerExecuted,
            ...(event.providerMetadata === undefined ? {} : { metadata: event.providerMetadata }),
          },
        })
        return
      }
      case "step-finish":
        yield* flush()
        assistantActive = false
        if (stepSettlement) return yield* Effect.die("Duplicate step finish")
        stepSettlement = { finish: event.reason, tokens: tokens(event.usage) }
        return
      case "finish":
        return
      case "provider-error":
        providerFailed = true
        yield* failAssistant(event.message)
        return
    }
  })

  return {
    publish,
    flush,
    flushDeltas: flushDeltaBuffers,
    failAssistant,
    failUnsettledTools,
    hasActiveAssistant: () => assistantActive,
    hasAssistantStarted: () => assistantMessageID !== undefined,
    hasProviderError: () => providerFailed,
    stepSettlement: () => stepSettlement,
    startAssistant,
    assistantMessageID: assistantMessageIDForTool,
  }
}
