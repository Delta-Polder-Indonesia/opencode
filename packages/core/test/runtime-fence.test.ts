import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Clock, Effect } from "effect"
import { BackgroundJob } from "@opencode-ai/core/background-job"
import { BackgroundJobTable, RuntimeFenceTable } from "@opencode-ai/core/background-job/sql"
import { BackgroundJobStore } from "@opencode-ai/core/background-job/store"
import { Config } from "@opencode-ai/core/config"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionInputTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionWake } from "@opencode-ai/core/session/wake"
import { SessionStore } from "@opencode-ai/core/session/store"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { JobTool } from "@opencode-ai/core/tool/job"
import { testEffect } from "./lib/effect"

const sessionID = SessionV2.ID.make("ses_fence_test")
const foreignRuntime = "runtime_foreign_expired"
const liveRuntime = "runtime_foreign_live"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      JobTool.node,
      BackgroundJob.node,
    ]),
    [[ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig]],
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
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "test",
      directory: "/project",
      title: "test",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

/** Clear any fence the RuntimeFence layer claimed at boot. */
const clearFence = Database.Service.use(({ db }) => db.delete(RuntimeFenceTable).run().pipe(Effect.orDie))

const seedFence = (runtimeID: string, heartbeatAt: number) =>
  Database.Service.use(({ db }) =>
    db
      .insert(RuntimeFenceTable)
      .values({ runtime_id: runtimeID, heartbeat_at: heartbeatAt })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie),
  )

const seedJob = (input: { id: string; runtimeID: string; status?: BackgroundJob.Status; sessionID?: string }) =>
  Database.Service.use(({ db }) =>
    db
      .insert(BackgroundJobTable)
      .values({
        id: input.id,
        type: "bash",
        title: "seed",
        session_id: (input.sessionID ?? sessionID) as SessionV2.ID | null,
        status: input.status ?? "running",
        runtime_id: input.runtimeID,
        started_at: 1,
        metadata: null,
      })
      .run()
      .pipe(Effect.orDie),
  )

const fenceRow = (runtimeID: string) =>
  Database.Service.use(({ db }) =>
    db.select().from(RuntimeFenceTable).where(eq(RuntimeFenceTable.runtime_id, runtimeID)).get().pipe(Effect.orDie),
  )

const jobStatus = (id: string) =>
  Database.Service.use(({ db }) =>
    db
      .select({ status: BackgroundJobTable.status })
      .from(BackgroundJobTable)
      .where(eq(BackgroundJobTable.id, id))
      .get()
      .pipe(Effect.orDie),
  )

describe("Runtime fence store", () => {
  it.effect("claimFence succeeds when no fence exists", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* clearFence
      const claimed = yield* BackgroundJobStore.claimFence(db)
      expect(claimed).toBe(true)
      const row = yield* fenceRow(BackgroundJobStore.runtimeID())
      expect(row).toBeDefined()
      expect(row?.heartbeat_at).toBeGreaterThanOrEqual(0)
    }),
  )

  it.effect("claimFence succeeds when existing fence belongs to same runtime", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* clearFence
      yield* BackgroundJobStore.claimFence(db)
      expect(yield* BackgroundJobStore.claimFence(db)).toBe(true)
    }),
  )

  it.effect("claimFence fails when another runtime holds a live fence", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const now = yield* Clock.currentTimeMillis
      yield* clearFence
      yield* seedFence(liveRuntime, now - 1000)
      const claimed = yield* BackgroundJobStore.claimFence(db)
      expect(claimed).toBe(false)
    }),
  )

  it.effect("claimFence succeeds when existing fence is expired", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const now = yield* Clock.currentTimeMillis
      yield* clearFence
      yield* seedFence(foreignRuntime, now - BackgroundJobStore.FENCE_TTL_MS - 5000)
      const claimed = yield* BackgroundJobStore.claimFence(db)
      expect(claimed).toBe(true)
      const row = yield* fenceRow(BackgroundJobStore.runtimeID())
      expect(row).toBeDefined()
    }),
  )

  it.live("heartbeatFence renews the fence timestamp", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* clearFence
      yield* BackgroundJobStore.claimFence(db)
      const before = yield* fenceRow(BackgroundJobStore.runtimeID())
      yield* Effect.sleep(20)
      yield* BackgroundJobStore.heartbeatFence(db)
      const after = yield* fenceRow(BackgroundJobStore.runtimeID())
      expect(after?.heartbeat_at).toBeGreaterThan(before?.heartbeat_at ?? 0)
    }),
  )

  it.effect("releaseFence removes the fence row", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* clearFence
      yield* BackgroundJobStore.claimFence(db)
      expect(yield* fenceRow(BackgroundJobStore.runtimeID())).toBeDefined()
      yield* BackgroundJobStore.releaseFence(db)
      expect(yield* fenceRow(BackgroundJobStore.runtimeID())).toBeUndefined()
    }),
  )

  it.effect("fenceAge returns null for non-existent fence and age for existing fence", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      expect(yield* BackgroundJobStore.fenceAge(db, "runtime_nonesuch")).toBeNull()
      const now = yield* Clock.currentTimeMillis
      yield* seedFence(foreignRuntime, now - 5000)
      const age = yield* BackgroundJobStore.fenceAge(db, foreignRuntime)
      expect(age).toBeGreaterThanOrEqual(5000)
      expect(age).toBeLessThan(10000)
    }),
  )
})

describe("Fence-aware recovery", () => {
  it.effect("claims rows whose owning runtime fence is expired", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const now = yield* Clock.currentTimeMillis
      yield* seedFence(foreignRuntime, now - BackgroundJobStore.FENCE_TTL_MS - 5000)
      yield* seedJob({ id: "job_expired_fence", runtimeID: foreignRuntime })
      const claimed = yield* JobTool.recover(db, events)
      expect(claimed).toBe(1)
      expect(yield* jobStatus("job_expired_fence")).toMatchObject({ status: "interrupted" })
    }),
  )

  it.effect("skips rows whose owning runtime fence is still live", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const now = yield* Clock.currentTimeMillis
      yield* seedFence(liveRuntime, now - 1000)
      yield* seedJob({ id: "job_live_fence", runtimeID: liveRuntime })
      const claimed = yield* JobTool.recover(db, events)
      expect(claimed).toBe(0)
      expect(yield* jobStatus("job_live_fence")).toMatchObject({ status: "running" })
    }),
  )

  it.effect("claims rows with no fence row (pre-fence migration)", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      yield* seedJob({ id: "job_no_fence", runtimeID: "runtime_pre_fence" })
      const claimed = yield* JobTool.recover(db, events)
      expect(claimed).toBe(1)
      expect(yield* jobStatus("job_no_fence")).toMatchObject({ status: "interrupted" })
    }),
  )

  it.effect("skips current-runtime rows regardless of fence state", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      yield* seedJob({ id: "job_current_runtime", runtimeID: BackgroundJobStore.runtimeID() })
      const claimed = yield* JobTool.recover(db, events)
      expect(claimed).toBe(0)
      expect(yield* jobStatus("job_current_runtime")).toMatchObject({ status: "running" })
    }),
  )

  it.effect("mixed fences: expired claimed, live skipped, no-fence claimed", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const now = yield* Clock.currentTimeMillis
      yield* seedFence(foreignRuntime, now - BackgroundJobStore.FENCE_TTL_MS - 1000)
      yield* seedFence(liveRuntime, now - 1000)
      yield* seedJob({ id: "job_expired", runtimeID: foreignRuntime })
      yield* seedJob({ id: "job_live", runtimeID: liveRuntime })
      yield* seedJob({ id: "job_nofence", runtimeID: "runtime_unknown" })
      const claimed = yield* JobTool.recover(db, events)
      expect(claimed).toBe(2)
      expect(yield* jobStatus("job_expired")).toMatchObject({ status: "interrupted" })
      expect(yield* jobStatus("job_live")).toMatchObject({ status: "running" })
      expect(yield* jobStatus("job_nofence")).toMatchObject({ status: "interrupted" })
    }),
  )
})
