import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { Database } from "@opencode-ai/core/database/database"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionV2 } from "@opencode-ai/core/session"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { BackgroundJobStore } from "@opencode-ai/core/background-job/store"
import { SessionRecoveryStore } from "@opencode-ai/core/session/recovery/store"
import { SessionExecutionLeaseTable, SessionProviderAttemptTable } from "@opencode-ai/core/session/recovery/sql"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { testEffect } from "./lib/effect"

const sessionID = SessionV2.ID.make("ses_recovery_test")
const it = testEffect(LayerNode.compile(LayerNode.group([Database.node])))

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
      slug: "recovery",
      directory: "/project",
      title: "recovery",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

describe("Session continuation recovery", () => {
  it.effect("fences dispatched ambiguity and requires explicit confirmation before retry", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      yield* db
        .insert(SessionProviderAttemptTable)
        .values({
          id: "attempt_dispatch_ambiguous",
          session_id: sessionID,
          runtime_id: "runtime_previous",
          fence: 4,
          step: 1,
          status: "dispatched",
          retry_count: 0,
          prepared_at: 1,
          dispatched_at: 2,
          lease_until: 0,
        })
        .run()
        .pipe(Effect.orDie)

      const discovered = yield* SessionRecoveryStore.discover(db)
      expect(discovered).toHaveLength(1)
      expect(discovered[0]?._tag).toBe("Dispatched")
      const listed = yield* SessionRecoveryStore.list(db, sessionID)
      expect(listed[0]).toMatchObject({
        status: "abandoned",
        recovery: "decision_required",
        error: SessionRecoveryStore.UNKNOWN_DISPATCH_ERROR,
        fence: 5,
      })

      const blocked = yield* SessionRecoveryStore.retry(db, "attempt_dispatch_ambiguous")
      expect(blocked._tag).toBe("ConfirmationRequired")
      const accepted = yield* SessionRecoveryStore.retry(db, "attempt_dispatch_ambiguous", true)
      expect(accepted._tag).toBe("Retried")
      expect((yield* SessionRecoveryStore.list(db, sessionID))[0]).toMatchObject({
        status: "prepared",
        recovery: "retry_ready",
        retryCount: 1,
      })
    }),
  )

  it.effect("marks preparation-only loss safe for one bounded automatic retry", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      yield* db
        .insert(SessionProviderAttemptTable)
        .values({
          id: "attempt_prepared_loss",
          session_id: sessionID,
          runtime_id: "runtime_previous",
          fence: 1,
          step: 2,
          status: "prepared",
          retry_count: 0,
          prepared_at: 1,
        })
        .run()
        .pipe(Effect.orDie)

      const discovered = yield* SessionRecoveryStore.discover(db)
      expect(discovered[0]?._tag).toBe("Prepared")
      yield* TestClock.adjust("2 seconds")
      expect(yield* SessionRecoveryStore.consumeSafeRetry(db, sessionID)).toBe(1)
      expect((yield* SessionRecoveryStore.list(db, sessionID))[0]).toMatchObject({
        status: "abandoned",
        recovery: "auto_retrying",
        error: SessionRecoveryStore.SAFE_RETRY_ERROR,
      })
      expect(yield* SessionRecoveryStore.consumeSafeRetry(db, sessionID)).toBeUndefined()
    }),
  )

  it.effect("reports an exhausted explicit retry budget without preparing a call", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      yield* db
        .insert(SessionProviderAttemptTable)
        .values({
          id: "attempt_budget_exhausted",
          session_id: sessionID,
          runtime_id: "runtime_previous",
          fence: 3,
          step: 1,
          status: "abandoned",
          recovery: "decision_required",
          retry_count: 2,
          prepared_at: 1,
          completed_at: 2,
        })
        .run()
        .pipe(Effect.orDie)

      const result = yield* SessionRecoveryStore.retry(db, "attempt_budget_exhausted", true)
      expect(result._tag).toBe("BudgetExhausted")
      expect((yield* SessionRecoveryStore.list(db, sessionID))[0]?.status).toBe("abandoned")
    }),
  )

  it.effect("rejects provider settlement after an attempt lease expires", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      yield* db
        .insert(SessionProviderAttemptTable)
        .values({
          id: "attempt_expired_settlement",
          session_id: sessionID,
          runtime_id: BackgroundJobStore.runtimeID(),
          fence: 2,
          step: 1,
          status: "dispatched",
          retry_count: 0,
          prepared_at: 1,
          dispatched_at: 2,
          lease_until: 0,
          heartbeat_at: 0,
        })
        .run()
        .pipe(Effect.orDie)
      const attempt = (yield* SessionRecoveryStore.list(db, sessionID))[0]
      expect(attempt).toBeDefined()
      expect(yield* SessionRecoveryStore.settle(db, attempt!, "succeeded")).toBe(false)
      expect((yield* SessionRecoveryStore.list(db, sessionID))[0]?.status).toBe("dispatched")
    }),
  )

  it.effect("lets one runtime acquire an expired Session lease and fences the prior owner", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      yield* db
        .insert(SessionExecutionLeaseTable)
        .values({
          session_id: sessionID,
          runtime_id: "runtime_previous",
          fence: 9,
          heartbeat_at: 1,
          lease_until: 0,
        })
        .run()
        .pipe(Effect.orDie)

      const lease = yield* SessionRecoveryStore.sessionLease.acquire(db, sessionID)
      expect(lease).toMatchObject({ runtimeID: BackgroundJobStore.runtimeID(), fence: 10 })
      expect(
        yield* db
          .select()
          .from(SessionExecutionLeaseTable)
          .where(eq(SessionExecutionLeaseTable.session_id, sessionID))
          .get()
          .pipe(Effect.orDie),
      ).toMatchObject({ runtime_id: BackgroundJobStore.runtimeID(), fence: 10 })
    }),
  )
})
