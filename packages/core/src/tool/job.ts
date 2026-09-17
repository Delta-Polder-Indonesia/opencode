export * as JobTool from "./job"

import { Effect, Layer, Schema, Scope } from "effect"
import { BackgroundJob } from "../background-job"
import type { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import type { EventV2 } from "../event"
import { PositiveInt } from "../schema"
import { SessionInput } from "../session/input"
import { SessionMessage } from "../session/message"
import { Prompt } from "../session/prompt"
import type { SessionSchema } from "../session/schema"
import { Tool } from "./tool"
import { ToolRegistry } from "./registry"
import { Tools } from "./tools"

export const GET_NAME = "job_get"
export const WAIT_NAME = "job_wait"
export const CANCEL_NAME = "job_cancel"

export const DEFAULT_WAIT_TIMEOUT_MS = 30_000
export const MAX_WAIT_TIMEOUT_MS = 300_000
/** Bounded model-facing preview inside the inbox completion note. */
export const NOTE_OUTPUT_PREVIEW_BYTES = 1500

/**
 * Ownership and observation metadata stored on every tool-launched background
 * job. Ownership is the session that launched the job; `job_*` tools refuse to
 * reveal or control jobs owned by other sessions (reported as unknown).
 */
export type OwnerMetadata = {
  sessionID: string
  agent: string
  assistantMessageID: string
  toolCallID: string
  command: string
  directory: string
}

export const owns = (info: BackgroundJob.Info, sessionID: SessionSchema.ID) => info.metadata?.sessionID === sessionID

export const title = (command: string) => {
  const single = command.replaceAll("\n", " ").trim()
  return single.length <= 80 ? single : `${single.slice(0, 79)}…`
}

const tail = (output: string, bytes: number) => {
  if (output.length <= bytes) return output
  return `…${output.slice(output.length - bytes)}`
}

export interface LaunchInput {
  readonly jobs: BackgroundJob.Interface
  readonly db: Database.Interface["db"]
  readonly events: EventV2.Interface
  /** Long-lived scope (Location scope) that outlives the settling tool call. */
  readonly scope: Scope.Scope
  readonly type: string
  readonly sessionID: SessionSchema.ID
  readonly agent: string
  readonly assistantMessageID: SessionMessage.ID
  readonly toolCallID: string
  readonly command: string
  readonly directory: string
  readonly run: Effect.Effect<string, unknown>
}

const completionNote = (info: BackgroundJob.Info) => {
  const outcome =
    info.status === "error"
      ? `error: ${info.error ?? "unknown"}`
      : (info.output?.match(/Command exited with code \d+\./)?.[0] ?? `status: ${info.status}`)
  const body = info.output
    ? `output (last ${NOTE_OUTPUT_PREVIEW_BYTES} bytes shown):\n${tail(info.output, NOTE_OUTPUT_PREVIEW_BYTES)}`
    : "(no output captured)"
  return [
    `[background job ${info.id} ${info.status}] ${info.title ?? info.id}`,
    outcome,
    body,
    `Full output: ${GET_NAME}({ id: "${info.id}" }).`,
  ].join("\n\n")
}

/**
 * Admit one durable queue-delivery session input reporting job completion. Same
 * admission path as user prompts, so the note is recorded once and surfaces
 * through normal queued-input promotion on the session's next activity.
 * Cancelled jobs are never delivered: the cancelling actor already knows.
 * Delivery never auto-resumes a session — see specs/v2/background-jobs.md.
 */
const deliver = Effect.fn("JobTool.deliver")(function* (
  db: Database.Interface["db"],
  events: EventV2.Interface,
  input: LaunchInput,
  info: BackgroundJob.Info,
) {
  if (info.status === "cancelled" || info.status === "running") return
  yield* SessionInput.admit(db, events, {
    id: SessionMessage.ID.create(),
    sessionID: input.sessionID,
    prompt: Prompt.fromUserMessage({ text: completionNote(info) }),
    delivery: "queue",
  })
})

/**
 * Launch one tool-owned background job and fork its completion delivery watcher.
 * The watcher waits for settlement, then admits the durable completion note. It
 * lives in the long-lived location scope (not the settling fiber), tolerates
 * every inbox/database failure (jobs must stay observable even if delivery is
 * unavailable), and is bounded by the process-local registry's own lifetime.
 */
export const launch = Effect.fn("JobTool.launch")(function* (input: LaunchInput) {
  const info = yield* input.jobs.start({
    type: input.type,
    title: title(input.command),
    metadata: {
      sessionID: input.sessionID,
      agent: input.agent,
      assistantMessageID: input.assistantMessageID,
      toolCallID: input.toolCallID,
      command: input.command,
      directory: input.directory,
    } satisfies OwnerMetadata,
    run: input.run,
  })
  yield* input.jobs.wait({ id: info.id }).pipe(
    Effect.flatMap((result) =>
      result.info === undefined ? Effect.void : deliver(input.db, input.events, input, result.info),
    ),
    Effect.catch(() => Effect.void),
    Effect.catchDefect(() => Effect.void),
    Effect.forkIn(input.scope),
  )
  return info
})

const unknownJob = (id: string) => new Tool.Failure({ message: `Unknown job: ${id}` })

const InfoFields = {
  id: Schema.String,
  type: Schema.String,
  status: Schema.Literals(["running", "completed", "error", "cancelled"]),
  title: Schema.optional(Schema.String),
  started_at: Schema.Number,
  completed_at: Schema.optional(Schema.Number),
  output: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
}

const infoOutput = (info: BackgroundJob.Info) => ({
  id: info.id,
  type: info.type,
  status: info.status,
  ...(info.title === undefined ? {} : { title: info.title }),
  started_at: info.started_at,
  ...(info.completed_at === undefined ? {} : { completed_at: info.completed_at }),
  ...(info.output === undefined ? {} : { output: info.output }),
  ...(info.error === undefined ? {} : { error: info.error }),
})

const describeInfo = (info: { id: string; type: string; status: string; output?: string; error?: string }) => {
  const lines = [
    `job ${info.id}`,
    `type: ${info.type}`,
    `status: ${info.status}`,
    ...(info.output === undefined ? [] : [`output:\n${tail(info.output, 64_000)}`]),
    ...(info.error === undefined ? [] : [`error: ${info.error}`]),
  ]
  return lines.join("\n")
}

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const jobs = yield* BackgroundJob.Service

    const requireOwned = Effect.fn("JobTool.requireOwned")(function* (id: string, context: Tool.Context) {
      const info = yield* jobs.get(id)
      if (!info || !owns(info, context.sessionID)) return yield* Effect.fail(unknownJob(id))
      return info
    })

    yield* tools
      .register({
        [GET_NAME]: Tool.make({
          description: `Read the latest status, output, and error of a background job owned by this session (for example one started by the bash tool with background: true). Jobs owned by other sessions are invisible and reported as unknown.`,
          input: Schema.Struct({
            id: Schema.String.annotate({ description: "Background job id returned when the job was launched" }),
          }),
          output: Schema.Struct(InfoFields),
          toModelOutput: ({ output }) => [{ type: "text", text: describeInfo(output) }],
          execute: (input, context) => requireOwned(input.id, context).pipe(Effect.map(infoOutput)),
        }),
        [WAIT_NAME]: Tool.make({
          description: `Block until a background job owned by this session finishes, or until timeout milliseconds elapse (default: ${DEFAULT_WAIT_TIMEOUT_MS}; maximum: ${MAX_WAIT_TIMEOUT_MS}). Returns timedOut: true when the job is still running so polling is an explicit model choice. Use after launching with bash background: true to pull results inside the current turn instead of waiting for the automatic completion note.`,
          input: Schema.Struct({
            id: Schema.String.annotate({ description: "Background job id to wait for" }),
            timeout: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_WAIT_TIMEOUT_MS))
              .pipe(Schema.optional)
              .annotate({ description: "Wait bound in milliseconds" }),
          }),
          output: Schema.Struct({ ...InfoFields, timedOut: Schema.Boolean }),
          toModelOutput: ({ output }) => [
            {
              type: "text",
              text: `${describeInfo(output)}${output.timedOut ? "\ntimedOut: true (still running)" : ""}`,
            },
          ],
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* requireOwned(input.id, context)
              const result = yield* jobs.wait({ id: input.id, timeout: input.timeout ?? DEFAULT_WAIT_TIMEOUT_MS })
              if (!result.info || !owns(result.info, context.sessionID)) return yield* Effect.fail(unknownJob(input.id))
              return { ...infoOutput(result.info), timedOut: result.timedOut }
            }),
        }),
        [CANCEL_NAME]: Tool.make({
          description: `Cancel a running background job owned by this session. Cancellation is permanent, interrupts the job's work, and no completion note is delivered afterwards.`,
          input: Schema.Struct({
            id: Schema.String.annotate({ description: "Background job id to cancel" }),
          }),
          output: Schema.Struct(InfoFields),
          toModelOutput: ({ output }) => [{ type: "text", text: describeInfo(output) }],
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* requireOwned(input.id, context)
              const info = yield* jobs.cancel(input.id)
              if (!info) return yield* Effect.fail(unknownJob(input.id))
              return infoOutput(info)
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/job",
  layer,
  deps: [ToolRegistry.node, BackgroundJob.node],
})
