import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Deferred, Effect, Layer, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { BackgroundJob } from "@opencode-ai/core/background-job"
import { BackgroundJobTable } from "@opencode-ai/core/background-job/sql"
import { BackgroundJobStore } from "@opencode-ai/core/background-job/store"
import { Config } from "@opencode-ai/core/config"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { LocationMutation } from "@opencode-ai/core/location-mutation"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AppProcess } from "@opencode-ai/core/process"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionInputTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionWake } from "@opencode-ai/core/session/wake"
import { SessionStore } from "@opencode-ai/core/session/store"
import { BashTool } from "@opencode-ai/core/tool/bash"
import { JobTool } from "@opencode-ai/core/tool/job"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { toolIdentity, settleTool, executeTool, toolDefinitions } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_job_tool_test")
const foreignSessionID = SessionV2.ID.make("ses_job_tool_foreign")

const call = (name: string, input: unknown, id = `call-${name}`): ToolRegistry.ExecuteInput => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call", id, name, input },
})

const ownerMetadata = (owner: string = sessionID): JobTool.OwnerMetadata => ({
  sessionID: owner,
  agent: toolIdentity.agent,
  assistantMessageID: toolIdentity.assistantMessageID,
  toolCallID: "call-seed",
  command: "seed",
  directory: "/tmp",
})

/** Owner-bound tool tests start jobs registry-side only (no persisted rows). */
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      JobTool.node,
      BackgroundJob.node,
    ]),
    [[ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig]],
  ),
)

describe("JobTools", () => {
  it.effect("advertises exactly the owner-bound job tools", () =>
    Effect.gen(function* () {
      const definitions = yield* toolDefinitions(yield* ToolRegistry.Service)
      expect(definitions.map((tool) => tool.name)).toEqual(["job_get", "job_wait", "job_cancel"])
    }),
  )

  it.effect("job_get reports owned jobs and hides foreign jobs as unknown", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const registry = yield* ToolRegistry.Service

      const own = yield* jobs.start({
        type: "bash",
        metadata: ownerMetadata(),
        run: Deferred.make<string>().pipe(Effect.flatMap(Deferred.await)),
      })
      const foreign = yield* jobs.start({
        type: "bash",
        metadata: ownerMetadata(foreignSessionID),
        run: Deferred.make<string>().pipe(Effect.flatMap(Deferred.await)),
      })

      const owned = yield* settleTool(registry, call("job_get", { id: own.id }))
      expect(owned.output?.structured).toMatchObject({ id: own.id, type: "bash", status: "running" })

      expect(yield* executeTool(registry, call("job_get", { id: foreign.id }))).toEqual({
        type: "error",
        value: `Unknown job: ${foreign.id}`,
      })
    }),
  )

  it.live("job_wait times out explicitly and resolves with output after completion", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const registry = yield* ToolRegistry.Service
      const gate = yield* Deferred.make<void>()
      const job = yield* jobs.start({
        type: "bash",
        metadata: ownerMetadata(),
        run: Deferred.await(gate).pipe(Effect.as("done-output")),
      })

      const timedOut = yield* settleTool(registry, call("job_wait", { id: job.id, timeout: 10 }))
      expect(timedOut.output?.structured).toMatchObject({ status: "running", timedOut: true })

      yield* Deferred.succeed(gate, undefined)
      const settled = yield* settleTool(registry, call("job_wait", { id: job.id, timeout: 5_000 }))
      expect(settled.output?.structured).toMatchObject({
        status: "completed",
        timedOut: false,
        output: "done-output",
      })
    }),
  )

  it.effect("job_cancel interrupts owned jobs and refuses foreign jobs", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const registry = yield* ToolRegistry.Service
      const gate = yield* Deferred.make<void>()
      const own = yield* jobs.start({
        type: "bash",
        metadata: ownerMetadata(),
        run: Deferred.await(gate).pipe(Effect.as("never")),
      })
      const foreign = yield* jobs.start({
        type: "bash",
        metadata: ownerMetadata(foreignSessionID),
        run: Deferred.make<string>().pipe(Effect.flatMap(Deferred.await)),
      })

      const cancelled = yield* settleTool(registry, call("job_cancel", { id: own.id }))
      expect(cancelled.output?.structured).toMatchObject({ id: own.id, status: "cancelled" })
      expect(yield* jobs.get(own.id)).toMatchObject({ status: "cancelled" })

      expect(yield* executeTool(registry, call("job_cancel", { id: foreign.id }))).toEqual({
        type: "error",
        value: `Unknown job: ${foreign.id}`,
      })
      expect(yield* jobs.get(foreign.id)).toMatchObject({ status: "running" })
    }),
  )
})

/* ------------------------------------------------------------------------- */
/* Completion delivery: real database + event stack, mocked process boundary. */

const assertions: PermissionV2.AssertInput[] = []
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) => Effect.sync(() => assertions.push(input)),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

let processGate: Deferred.Deferred<void> | undefined
let processOutput: Buffer = Buffer.from("mock-output\n")
const appProcess = Layer.succeed(
  AppProcess.Service,
  AppProcess.Service.of({
    run: (command: ChildProcess.Command, _options?: AppProcess.RunOptions) =>
      Effect.suspend(() => {
        if (command._tag !== "StandardCommand") throw new Error("expected standard command")
        const done: AppProcess.RunResult = {
          command: "mock",
          exitCode: 0,
          output: processOutput,
          stdout: processOutput,
          stderr: Buffer.alloc(0),
          outputTruncated: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        }
        return processGate ? Effect.as(Deferred.await(processGate), done) : Effect.succeed(done)
      }),
  } as unknown as AppProcess.Interface),
)

const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () => Effect.succeed([]),
  }),
)

const wakeRequests: SessionV2.ID[] = []
const sessionWake = Layer.succeed(
  SessionWake.Service,
  SessionWake.Service.of({
    request: (sessionID) =>
      Effect.sync(() => {
        wakeRequests.push(sessionID)
      }),
    subscribe: Effect.succeed(Stream.empty),
  }),
)

const itDb = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      LocationMutation.node,
      BashTool.node,
      JobTool.node,
      BackgroundJob.node,
    ]),
    [
      [
        Location.node,
        Layer.unwrap(
          Effect.acquireRelease(
            Effect.promise(() => tmpdir()),
            (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
          ).pipe(
            Effect.map((tmp) =>
              Layer.succeed(
                Location.Service,
                Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
              ),
            ),
          ),
        ),
      ],
      [PermissionV2.node, permission],
      [AppProcess.node, appProcess],
      [Config.node, config],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      [SessionWake.node, sessionWake],
    ],
  ),
)

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  for (const id of [sessionID, foreignSessionID]) {
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.global,
        slug: "test",
        directory: "/project",
        title: "test",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  }
})

const deliveredNotes = Database.Service.use(({ db }) =>
  db
    .select()
    .from(SessionInputTable)
    .where(eq(SessionInputTable.session_id, sessionID))
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.filter((row) => row.prompt.text.includes("[background job"))),
    ),
)

type NoteRow = typeof SessionInputTable.$inferSelect

const pollWakes = (count: number, attempts = 500): Effect.Effect<void> =>
  wakeRequests.length >= count
    ? Effect.void
    : attempts <= 0
      ? Effect.void
      : Effect.sleep(1).pipe(Effect.andThen(pollWakes(count, attempts - 1)))

const pollNotes = (count: number, attempts = 500): Effect.Effect<NoteRow[], never, Database.Service> =>
  deliveredNotes.pipe(
    Effect.flatMap((rows) =>
      rows.length >= count
        ? Effect.succeed(rows)
        : attempts <= 0
          ? Effect.succeed(rows)
          : Effect.sleep(1).pipe(Effect.andThen(pollNotes(count, attempts - 1))),
    ),
  )

describe("Background completion delivery", () => {
  itDb.live("delivers a durable steered session input and wakes the owner session when a job completes", () =>
    Effect.gen(function* () {
      yield* setup
      wakeRequests.length = 0
      processGate = undefined
      processOutput = Buffer.from("mock-output\n")
      const registry = yield* ToolRegistry.Service
      const jobs = yield* BackgroundJob.Service

      const settled = yield* settleTool(registry, call("bash", { command: "printf hi", background: true }, "call-bg"))
      const job = (settled.output?.structured as { job?: string }).job
      expect(typeof job).toBe("string")

      const waited = yield* jobs.wait({ id: job! })
      expect(waited.info).toMatchObject({ status: "completed" })

      const notes = yield* pollNotes(1)
      const note = notes.find((row) => row.prompt.text.includes(job!))
      expect(note).toBeDefined()
      expect(note?.delivery).toBe("steer")
      expect(note?.promoted_seq).toBeNull()
      expect(note?.prompt.text).toContain(`[background job ${job} completed]`)
      expect(note?.prompt.text).toContain("Command exited with code 0.")
      expect(note?.prompt.text).toContain("mock-output")
      expect(note?.prompt.text).toContain(`job_get({ id: "${job}" })`)
      yield* pollWakes(1)
      expect(wakeRequests).toEqual([sessionID])
    }),
  )

  itDb.live("delivers nothing when a job is cancelled", () =>
    Effect.gen(function* () {
      yield* setup
      wakeRequests.length = 0
      processOutput = Buffer.from("mock-output\n")
      const registry = yield* ToolRegistry.Service
      const jobs = yield* BackgroundJob.Service
      processGate = yield* Deferred.make<void>()

      const settled = yield* settleTool(
        registry,
        call("bash", { command: "sleep 30", background: true }, "call-bg-cancel"),
      )
      const job = (settled.output?.structured as { job?: string }).job
      expect(typeof job).toBe("string")

      const cancelled = yield* jobs.cancel(job!)
      expect(cancelled).toMatchObject({ status: "cancelled" })
      yield* Deferred.succeed(processGate, undefined)
      processGate = undefined

      // Give a (broken) delivery path ample opportunity to fire, then assert absence.
      yield* Effect.sleep(50)
      const notes = yield* deliveredNotes
      expect(notes.filter((row) => row.prompt.text.includes(job!))).toEqual([])
      expect(wakeRequests).toEqual([])
    }),
  )
})

/* ------------------------------------------------------------------------- */
/* Durable status + restart recovery (gate 1).                               */

const seedRow = (input: {
  id: string
  status: BackgroundJob.Status
  runtimeID: string
  sessionID?: string
  metadata?: Record<string, unknown>
  error?: string
  startedAt?: number
  leaseUntil?: number | null
  heartbeatAt?: number | null
  fence?: number
}) =>
  Database.Service.use(({ db }) =>
    db
      .insert(BackgroundJobTable)
      .values({
        id: input.id,
        type: "bash",
        title: "seed",
        session_id: (input.sessionID ?? null) as SessionV2.ID | null,
        status: input.status,
        runtime_id: input.runtimeID,
        started_at: input.startedAt ?? 1,
        metadata: input.metadata ?? null,
        error: input.error ?? null,
        lease_until: input.leaseUntil,
        heartbeat_at: input.heartbeatAt,
        fence: input.fence,
      })
      .run()
      .pipe(Effect.orDie),
  )

const jobRow = (id: string) =>
  Database.Service.use(({ db }) =>
    db.select().from(BackgroundJobTable).where(eq(BackgroundJobTable.id, id)).get().pipe(Effect.orDie),
  )

const pollJobStatus = (
  id: string,
  status: string,
  attempts = 500,
): Effect.Effect<typeof BackgroundJobTable.$inferSelect | undefined, never, Database.Service> =>
  jobRow(id).pipe(
    Effect.flatMap((row) =>
      row?.status === status
        ? Effect.succeed(row)
        : attempts <= 0
          ? Effect.succeed(row)
          : Effect.sleep(1).pipe(Effect.andThen(pollJobStatus(id, status, attempts - 1))),
    ),
  )

const allNotes = Database.Service.use(({ db }) => db.select().from(SessionInputTable).all().pipe(Effect.orDie))

describe("Durable job status", () => {
  itDb.live("persists launch as running and settlement with a bounded output tail", () =>
    Effect.gen(function* () {
      yield* setup
      processGate = yield* Deferred.make<void>()
      processOutput = Buffer.from("x".repeat(BackgroundJobStore.MAX_PERSISTED_OUTPUT_BYTES + 4096))
      const registry = yield* ToolRegistry.Service
      const jobs = yield* BackgroundJob.Service

      const settled = yield* settleTool(
        registry,
        call("bash", { command: "big-output", background: true }, "call-bg-durable"),
      )
      const job = (settled.output?.structured as { job?: string }).job!
      expect(typeof job).toBe("string")

      const running = yield* jobRow(job)
      expect(running?.status).toBe("running")
      expect(running?.session_id).toBe(sessionID)
      expect(running?.runtime_id).toBe(BackgroundJobStore.runtimeID())
      expect(running?.metadata).toMatchObject({ sessionID, command: "big-output" })

      yield* Deferred.succeed(processGate, undefined)
      processGate = undefined
      const waited = yield* jobs.wait({ id: job })
      expect(waited.info).toMatchObject({ status: "completed" })

      const done = yield* pollJobStatus(job, "completed")
      expect(done?.status).toBe("completed")
      expect(done?.completed_at).not.toBeNull()
      const full = `${processOutput.toString("utf8")}\n\nCommand exited with code 0.`
      expect(done?.output).toBe(`…${full.slice(-BackgroundJobStore.MAX_PERSISTED_OUTPUT_BYTES)}`)
      expect(done?.output?.length).toBe(BackgroundJobStore.MAX_PERSISTED_OUTPUT_BYTES + 1)
      processOutput = Buffer.from("mock-output\n")
    }),
  )

  itDb.live("persists cancellation as a terminal cancelled row", () =>
    Effect.gen(function* () {
      yield* setup
      processGate = yield* Deferred.make<void>()
      const registry = yield* ToolRegistry.Service
      const jobs = yield* BackgroundJob.Service

      const settled = yield* settleTool(
        registry,
        call("bash", { command: "cancel-me", background: true }, "call-bg-durable-cancel"),
      )
      const job = (settled.output?.structured as { job?: string }).job!
      const cancelled = yield* jobs.cancel(job)
      expect(cancelled).toMatchObject({ status: "cancelled" })
      yield* Deferred.succeed(processGate, undefined)
      processGate = undefined

      const row = yield* pollJobStatus(job, "cancelled")
      expect(row?.status).toBe("cancelled")
      expect(row?.completed_at).not.toBeNull()
      expect(row?.output ?? null).toBeNull()
    }),
  )
})

describe("Restart recovery", () => {
  itDb.effect("claims foreign-runtime running rows as interrupted and notifies the owner session", () =>
    Effect.gen(function* () {
      yield* setup
      wakeRequests.length = 0
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const jobID = "job_recovery_claim"
      yield* seedRow({
        id: jobID,
        status: "running",
        runtimeID: "runtime_previous",
        sessionID,
        metadata: { ...ownerMetadata(), command: "lost-command" },
      })

      const claimed = yield* JobTool.recover(db, events)
      expect(claimed).toBe(1)

      const row = yield* jobRow(jobID)
      expect(row?.status).toBe("interrupted")
      expect(row?.error).toBe(BackgroundJobStore.INTERRUPTED_ERROR)
      expect(row?.completed_at).not.toBeNull()

      const notes = yield* deliveredNotes
      const note = notes.find((n) => n.prompt.text.includes(jobID))
      expect(note).toBeDefined()
      expect(note?.delivery).toBe("queue")
      expect(wakeRequests).toEqual([])
      expect(note?.promoted_seq).toBeNull()
      expect(note?.prompt.text).toContain(`[background job ${jobID} interrupted]`)
      expect(note?.prompt.text).toContain(BackgroundJobStore.INTERRUPTED_ERROR)
    }),
  )

  itDb.effect("leaves current-runtime and settled rows untouched", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      yield* seedRow({
        id: "job_recovery_live",
        status: "running",
        runtimeID: BackgroundJobStore.runtimeID(),
        sessionID,
        metadata: ownerMetadata(),
      })
      yield* seedRow({
        id: "job_recovery_done",
        status: "completed",
        runtimeID: "runtime_previous",
        sessionID,
        metadata: ownerMetadata(),
      })

      const claimed = yield* JobTool.recover(db, events)
      expect(claimed).toBe(0)
      expect((yield* jobRow("job_recovery_live"))?.status).toBe("running")
      expect((yield* jobRow("job_recovery_done"))?.status).toBe("completed")
      expect(yield* deliveredNotes).toEqual([])
    }),
  )

  itDb.effect("claims ownerless rows but skips note delivery for deleted sessions", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      yield* seedRow({
        id: "job_recovery_orphan",
        status: "running",
        runtimeID: "runtime_previous",
        metadata: { ...ownerMetadata(), sessionID: "ses_deleted_elsewhere" },
      })

      const claimed = yield* JobTool.recover(db, events)
      expect(claimed).toBe(1)
      expect((yield* jobRow("job_recovery_orphan"))?.status).toBe("interrupted")
      const notes = yield* allNotes
      expect(notes.filter((row) => row.prompt.text.includes("job_recovery_orphan"))).toEqual([])
    }),
  )

  itDb.effect("job tools serve persisted rows after registry loss and keep owner hiding", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      yield* seedRow({
        id: "job_persisted_own",
        status: "interrupted",
        runtimeID: "runtime_previous",
        sessionID,
        metadata: ownerMetadata(),
        error: BackgroundJobStore.INTERRUPTED_ERROR,
      })
      yield* seedRow({
        id: "job_persisted_foreign",
        status: "completed",
        runtimeID: "runtime_previous",
        sessionID: foreignSessionID,
        metadata: ownerMetadata(foreignSessionID),
      })

      const got = yield* settleTool(registry, call("job_get", { id: "job_persisted_own" }, "call-get-persisted"))
      expect(got.output?.structured).toMatchObject({
        id: "job_persisted_own",
        status: "interrupted",
        error: BackgroundJobStore.INTERRUPTED_ERROR,
      })

      const waited = yield* settleTool(
        registry,
        call("job_wait", { id: "job_persisted_own", timeout: 1 }, "call-wait-persisted"),
      )
      expect(waited.output?.structured).toMatchObject({ status: "interrupted", timedOut: false })

      const cancelled = yield* settleTool(
        registry,
        call("job_cancel", { id: "job_persisted_own" }, "call-cancel-persisted"),
      )
      expect(cancelled.output?.structured).toMatchObject({ status: "interrupted" })

      expect(yield* executeTool(registry, call("job_get", { id: "job_persisted_foreign" }))).toEqual({
        type: "error",
        value: "Unknown job: job_persisted_foreign",
      })
    }),
  )
})

describe("Background job fencing", () => {
  itDb.effect("does not recover a foreign owner while its lease is alive", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      yield* seedRow({
        id: "job_live_foreign_owner",
        status: "running",
        runtimeID: "runtime_other",
        sessionID,
        metadata: ownerMetadata(),
        leaseUntil: 1_000_000,
        heartbeatAt: 1,
        fence: 7,
      })

      expect(yield* BackgroundJobStore.recover(db)).toEqual([])
      expect((yield* jobRow("job_live_foreign_owner"))?.status).toBe("running")
    }),
  )

  itDb.effect("fences an expired owner before accepting an HTTP-style cancel", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      yield* seedRow({
        id: "job_stale_owner",
        status: "running",
        runtimeID: "runtime_dead",
        sessionID,
        metadata: ownerMetadata(),
        leaseUntil: 0,
        heartbeatAt: 0,
        fence: 3,
      })

      const result = yield* BackgroundJobStore.requestCancel(db, "job_stale_owner")
      expect(result._tag).toBe("StaleOwner")
      expect(result._tag === "StaleOwner" ? result.info.status : undefined).toBe("interrupted")

      const staleSettle = yield* BackgroundJobStore.settle(
        db,
        {
          id: "job_stale_owner",
          type: "bash",
          status: "completed",
          started_at: 0,
        },
        { runtimeID: "runtime_dead", fence: 3 },
      )
      expect(staleSettle).toBe(false)
      expect((yield* jobRow("job_stale_owner"))?.status).toBe("interrupted")
    }),
  )

  itDb.effect("records a live remote cancel for the owner heartbeat to acknowledge", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      yield* seedRow({
        id: "job_cancel_request",
        status: "running",
        runtimeID: BackgroundJobStore.runtimeID(),
        sessionID,
        metadata: ownerMetadata(),
        leaseUntil: 1_000_000,
        heartbeatAt: 1,
        fence: 5,
      })

      const result = yield* BackgroundJobStore.requestCancel(db, "job_cancel_request")
      expect(result._tag).toBe("Requested")
      const heartbeat = yield* BackgroundJobStore.heartbeat(db, "job_cancel_request", {
        runtimeID: BackgroundJobStore.runtimeID(),
        fence: 5,
      })
      expect(heartbeat).toMatchObject({ renewed: true, cancelRequested: true })
      expect((yield* jobRow("job_cancel_request"))?.status).toBe("running")
    }),
  )
})

describe("Durable observation list", () => {
  itDb.effect("lists rows newest-first with owner session, status, and limit filters", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      yield* seedRow({
        id: "job_list_old",
        status: "completed",
        runtimeID: "runtime_a",
        sessionID,
        metadata: ownerMetadata(),
        startedAt: 100,
      })
      yield* seedRow({
        id: "job_list_mid",
        status: "running",
        runtimeID: BackgroundJobStore.runtimeID(),
        sessionID,
        metadata: ownerMetadata(),
        startedAt: 200,
      })
      yield* seedRow({
        id: "job_list_foreign",
        status: "error",
        runtimeID: "runtime_b",
        sessionID: foreignSessionID,
        metadata: ownerMetadata(foreignSessionID),
        startedAt: 300,
      })
      yield* seedRow({
        id: "job_list_ownerless",
        status: "cancelled",
        runtimeID: "runtime_b",
        startedAt: 400,
      })

      const all = yield* BackgroundJobStore.list(db)
      expect(all.map((info) => info.id)).toEqual([
        "job_list_ownerless",
        "job_list_foreign",
        "job_list_mid",
        "job_list_old",
      ])

      const owned = yield* BackgroundJobStore.list(db, { sessionID })
      expect(owned.map((info) => info.id)).toEqual(["job_list_mid", "job_list_old"])
      expect(owned[0]).toMatchObject({ session_id: sessionID, status: "running", type: "bash" })

      const running = yield* BackgroundJobStore.list(db, { status: "running" })
      expect(running.map((info) => info.id)).toEqual(["job_list_mid"])

      const limited = yield* BackgroundJobStore.list(db, { limit: 2 })
      expect(limited.map((info) => info.id)).toEqual(["job_list_ownerless", "job_list_foreign"])

      const empty = yield* BackgroundJobStore.list(db, { sessionID: SessionV2.ID.make("ses_none") })
      expect(empty).toEqual([])
    }),
  )
})
