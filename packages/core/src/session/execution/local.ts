import { Cause, Effect, Layer, Stream } from "effect"
import { Database } from "../../database/database"
import { LocationServiceMap } from "../../location-service-map"
import { makeGlobalNode } from "../../effect/app-node"
import { SessionRunCoordinator } from "../run-coordinator"
import { SessionRunner } from "../runner"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { SessionExecution } from "../execution"
import { SessionWake } from "../wake"
import { SessionRecovery } from "../recovery"
import { SessionRecoveryStore } from "../recovery/store"

/** Current-process routing for implicit-local Locations. Future remote placement belongs here. */
const layer = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const database = yield* Database.Service
    const locations = yield* LocationServiceMap.Service
    const wakes = yield* SessionWake.Service
    // Building the root executor also performs non-executing startup discovery
    // for provider attempts. It only fences/records recovery state; it never
    // starts a provider turn or emits a wake.
    yield* (yield* SessionRecovery.Service).discovered
    const coordinator = yield* SessionRunCoordinator.make<SessionSchema.ID, SessionRunner.RunError>({
      drain: Effect.fnUntraced(function* (sessionID: SessionSchema.ID, force) {
        const session = yield* store.get(sessionID)
        if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
        const lease = yield* SessionRecoveryStore.sessionLease.acquire(database.db, sessionID)
        // Another runtime owns this Session. The durable inbox remains intact;
        // the caller that owns the lease is the only one allowed to dispatch a
        // provider turn.
        if (!lease) return
        const run = SessionRunner.Service.use((runner) => runner.run({ sessionID, force })).pipe(
          Effect.provide(locations.get(session.location)),
          Effect.tapCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logError("Failed to drain Session", cause).pipe(Effect.annotateLogs({ sessionID })),
          ),
        )
        const monitor = Effect.gen(function* () {
          while (true) {
            yield* Effect.sleep(SessionRecoveryStore.ATTEMPT_LEASE_DURATION_MS / 3)
            if (!(yield* SessionRecoveryStore.sessionLease.heartbeat(database.db, sessionID, lease)))
              return yield* Effect.interrupt
          }
        })
        return yield* Effect.raceFirst(run, monitor).pipe(
          Effect.ensuring(SessionRecoveryStore.sessionLease.release(database.db, sessionID, lease)),
        )
      }),
    })

    // Honor process-local advisory wakes: a Location-scoped publisher (tool
    // completion delivery) records durable inbox work and then asks for a
    // drain over the shared hub, because it cannot depend on execution. A wake
    // is edge-triggered and coalescing — the coordinator joins an active drain
    // or starts an idle one, and the runner only reaches a provider when
    // eligible durable input exists. Unknown Sessions are ignored: a deleted
    // Session cannot drain, and the durable rows disappear with it.
    const wakeSubscription = yield* wakes.subscribe
    yield* wakeSubscription.pipe(
      Stream.runForEach((sessionID) =>
        store.get(sessionID).pipe(
          Effect.flatMap((session) => (session === undefined ? Effect.void : coordinator.wake(sessionID))),
          Effect.catchCause((cause) => Effect.logWarning("Failed to handle a Session wake", cause)),
        ),
      ),
      Effect.forkScoped,
    )

    return SessionExecution.Service.of({
      active: coordinator.active,
      interrupt: coordinator.interrupt,
      resume: coordinator.run,
      wake: coordinator.wake,
    })
  }),
)

export const node = makeGlobalNode({
  service: SessionExecution.Service,
  layer,
  deps: [Database.node, SessionStore.node, LocationServiceMap.node, SessionWake.node, SessionRecovery.node],
})

export * as SessionExecutionLocal from "./local"
