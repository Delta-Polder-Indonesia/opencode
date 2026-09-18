export * as JobTool from "./job"

import { eq } from "drizzle-orm"
import { Effect, Layer, Schema, Scope } from "effect"
import { BackgroundJob } from "../background-job"
import { BackgroundJobStore } from "../background-job/store"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { PositiveInt } from "../schema"
import { RuntimeFence } from "../runtime-fence"
import { SessionInput } from "../session/input"
import { SessionMessage } from "../session/message"
import { Prompt } from "../session/prompt"
import { SessionSchema } from "../session/schema"
import { SessionWake } from "../session/wake"
import { SessionTable } from "../session/sql"
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
  /** Process-local wake signal for the owning Session (see `session/wake.ts`). */
  readonly wake: SessionWake.Interface
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
    info.status === "error" || info.status === "interrupted"
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

type NoteTarget = {
  readonly db: Database.Interface["db"]
  readonly events: EventV2.Interface
  readonly sessionID: SessionSchema.ID
  readonly info: BackgroundJob.Info
}

/**
 * Admit one durable session input reporting job settlement. Same admission
 * path as user prompts, so the note is recorded once and, once promoted,
 * becomes an ordinary visible user message. Cancelled jobs are never
 * delivered: the cancelling actor already knows. Returns whether a note was
 * admitted.
 */
const admitNote = Effect.fn("JobTool.admitNote")(function* (
  target: NoteTarget,
  delivery: SessionInput.Delivery,
) {
  if (target.info.status === "cancelled" || target.info.status === "running") return false
  yield* SessionInput.admit(target.db, target.events, {
    id: SessionMessage.ID.create(),
    sessionID: target.sessionID,
    prompt: Prompt.fromUserMessage({ text: completionNote(target.info) }),
    delivery,
  })
  return true
})

/**
 * Live settlement delivery: the note is a `steer` input, so an active drain
 * promotes it at its next safe provider-turn boundary, and the advisory wake
 * lets an idle Session resume instead of waiting for the next activity. The
 * wake is process-local and edge-triggered; the durable note never depends on
 * it. See specs/v2/background-jobs.md.
 */
const deliverSettled = Effect.fn("JobTool.deliverSettled")(function* (
  target: NoteTarget & { readonly wake: SessionWake.Interface },
) {
  if (yield* admitNote(target, "steer")) yield* target.wake.request(target.sessionID)
})

/**
 * Restart-recovery delivery: claimed rows stay `queue` inputs and never wake.
 * A process that just booted does not schedule provider work for its recovery
 * notes; the Session learns the job's fate on its next activity, and startup
 * discovery belongs to the deferred continuation-recovery slice.
 */
const deliverRecovered = Effect.fn("JobTool.deliverRecovered")(function* (target: NoteTarget) {
  yield* admitNote(target, "queue")
})

/**
 * Launch one tool-owned background job and fork its completion delivery watcher.
 * The watcher waits for settlement, persists the terminal status, admits the
 * durable completion note, then requests the advisory wake that resumes the
 * owning Session when it is idle. Persistence is ordered before delivery so a
 * crash in between recovers as `interrupted` (unknown outcome) rather than a
 * silently lost settlement. The watcher lives in the long-lived location scope
 * (not the settling fiber) and tolerates every durability/inbox/database
 * failure — a job is never lost or hidden because persistence is unavailable.
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
  yield* BackgroundJobStore.insert(input.db, info).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Failed to persist background job launch", cause).pipe(Effect.annotateLogs({ jobID: info.id })),
    ),
  )
  yield* input.jobs.wait({ id: info.id }).pipe(
    Effect.flatMap((result) =>
      result.info === undefined
        ? Effect.void
        : BackgroundJobStore.settle(input.db, result.info).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to persist background job settlement", cause).pipe(
                Effect.annotateLogs({ jobID: info.id }),
              ),
            ),
            Effect.andThen(
              deliverSettled({
                db: input.db,
                events: input.events,
                wake: input.wake,
                sessionID: input.sessionID,
                info: result.info,
              }),
            ),
          ),
    ),
    Effect.catch(() => Effect.void),
    Effect.catchDefect(() => Effect.void),
    Effect.forkIn(input.scope),
  )
  return info
})

/**
 * Restart recovery: claim every durable `running` row owned by a foreign
 * runtime as `interrupted`, then deliver the usual completion note to each
 * claimed job's owner session when that session still exists. Claiming and
 * delivery are independent: a delivery failure never unclaims the row, and
 * rows without owner metadata or with deleted sessions are still claimed.
 * Runs at tool-layer boot, before any tool can execute.
 */
export const recover = Effect.fn("JobTool.recover")(function* (
  db: Database.Interface["db"],
  events: EventV2.Interface,
) {
  const claimed = yield* BackgroundJobStore.recover(db)
  for (const info of claimed) {
    const owner = info.metadata?.sessionID
    if (typeof owner !== "string") continue
    const sessionID = SessionSchema.ID.make(owner)
    const session = yield* db
      .select({ id: SessionTable.id })
      .from(SessionTable)
      .where(eq(SessionTable.id, sessionID))
      .get()
      .pipe(Effect.orDie)
    if (!session) continue
    yield* deliverRecovered({ db, events, sessionID, info }).pipe(
      Effect.catch(() => Effect.void),
      Effect.catchDefect(() => Effect.void),
    )
  }
  return claimed.length
})

const unknownJob = (id: string) => new Tool.Failure({ message: `Unknown job: ${id}` })

const InfoFields = {
  id: Schema.String,
  type: Schema.String,
  status: Schema.Literals(["running", "completed", "error", "cancelled", "interrupted"]),
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
    const database = yield* Database.Service
    const events = yield* EventV2.Service

    yield* recover(database.db, events).pipe(
      Effect.catchCause((cause) => Effect.logError("Background job restart recovery failed", cause)),
    )

    const resolve = Effect.fn("JobTool.resolve")(function* (id: string, context: Tool.Context) {
      const live = yield* jobs.get(id)
      if (live) {
        if (!owns(live, context.sessionID)) return yield* Effect.fail(unknownJob(id))
        return live
      }
      const stored = yield* BackgroundJobStore.get(database.db, id)
      if (!stored || !owns(stored, context.sessionID)) return yield* Effect.fail(unknownJob(id))
      return stored
    })

    yield* tools
      .register({
        [GET_NAME]: Tool.make({
          description: `Read the latest status, output, and error of a background job owned by this session (for example one started by the bash tool with background: true). Jobs owned by other sessions are invisible and reported as unknown. Jobs from a previous process lifetime are reported with status interrupted.`,
          input: Schema.Struct({
            id: Schema.String.annotate({ description: "Background job id returned when the job was launched" }),
          }),
          output: Schema.Struct(InfoFields),
          toModelOutput: ({ output }) => [{ type: "text", text: describeInfo(output) }],
          execute: (input, context) => resolve(input.id, context).pipe(Effect.map(infoOutput)),
        }),
        [WAIT_NAME]: Tool.make({
          description: `Block until a background job owned by this session finishes, or until timeout milliseconds elapse (default: ${DEFAULT_WAIT_TIMEOUT_MS}; maximum: ${MAX_WAIT_TIMEOUT_MS}). Returns timedOut: true when the job is still running so polling is an explicit model choice. Already-settled jobs return immediately. Use after launching with bash background: true to pull results inside the current turn instead of waiting for the automatic completion note.`,
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
              const info = yield* resolve(input.id, context)
              if (info.status !== "running") return { ...infoOutput(info), timedOut: false }
              const result = yield* jobs.wait({ id: input.id, timeout: input.timeout ?? DEFAULT_WAIT_TIMEOUT_MS })
              if (!result.info || !owns(result.info, context.sessionID)) return yield* Effect.fail(unknownJob(input.id))
              return { ...infoOutput(result.info), timedOut: result.timedOut }
            }),
        }),
        [CANCEL_NAME]: Tool.make({
          description: `Cancel a running background job owned by this session. Cancellation is permanent, interrupts the job's work, and no completion note is delivered afterwards. Cancelling an already-settled job is a no-op that returns its status.`,
          input: Schema.Struct({
            id: Schema.String.annotate({ description: "Background job id to cancel" }),
          }),
          output: Schema.Struct(InfoFields),
          toModelOutput: ({ output }) => [{ type: "text", text: describeInfo(output) }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const info = yield* resolve(input.id, context)
              if (info.status !== "running") return infoOutput(info)
              const cancelled = yield* jobs.cancel(input.id)
              if (!cancelled) return yield* Effect.fail(unknownJob(input.id))
              return infoOutput(cancelled)
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/job",
  layer,
  deps: [ToolRegistry.node, BackgroundJob.node, Database.node, EventV2.node, RuntimeFence.node],
})
