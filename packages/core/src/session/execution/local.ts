import { Cause, Effect, Layer, Stream } from "effect"
import { LocationServiceMap } from "../../location-service-map"
import { makeGlobalNode } from "../../effect/app-node"
import { SessionRunCoordinator } from "../run-coordinator"
import { SessionRunner } from "../runner"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { SessionExecution } from "../execution"
import { SessionWake } from "../wake"

/** Current-process routing for implicit-local Locations. Future remote placement belongs here. */
const layer = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const locations = yield* LocationServiceMap.Service
    const wakes = yield* SessionWake.Service
    const coordinator = yield* SessionRunCoordinator.make<SessionSchema.ID, SessionRunner.RunError>({
      drain: Effect.fnUntraced(function* (sessionID: SessionSchema.ID, force) {
        const session = yield* store.get(sessionID)
        if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
        return yield* SessionRunner.Service.use((runner) => runner.run({ sessionID, force })).pipe(
          Effect.provide(locations.get(session.location)),
          Effect.tapCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logError("Failed to drain Session", cause).pipe(Effect.annotateLogs({ sessionID })),
          ),
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
  deps: [SessionStore.node, LocationServiceMap.node, SessionWake.node],
})

export * as SessionExecutionLocal from "./local"
