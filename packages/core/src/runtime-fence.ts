export * as RuntimeFence from "./runtime-fence"

import { Context, Duration, Effect, Layer, Schedule } from "effect"
import { BackgroundJobStore } from "./background-job/store"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"

/**
 * Process-global heartbeat interval for fence renewal. Must be comfortably
 * shorter than `BackgroundJobStore.FENCE_TTL_MS` so that one missed heartbeat
 * does not expire the fence.
 */
export const HEARTBEAT_INTERVAL_MS = 10_000

export interface Interface {
  /** True when the fence was successfully claimed at boot. */
  readonly claimed: Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/RuntimeFence") {}

/**
 * Process-scoped fence service. Claims the global fence row once on boot and
 * maintains a periodic heartbeat so that stale-owner recovery can distinguish
 * live runtimes from dead ones. Only one process may hold a live fence per
 * database; a second process that finds a live fence held by another runtime
 * must not proceed with recovery (the caller decides whether to retry, wait,
 * or abort).
 *
 * The heartbeat fiber lives in the global scope (not a Location scope), so
 * exactly one heartbeat loop runs per process regardless of how many Location
 * trees are built. Finalizer releases the fence row on clean shutdown.
 */
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const claimed = yield* BackgroundJobStore.claimFence(db)
    if (claimed) {
      yield* Effect.logInfo("Runtime fence claimed").pipe(
        Effect.annotateLogs({ runtimeID: BackgroundJobStore.runtimeID() }),
      )
      const heartbeat = BackgroundJobStore.heartbeatFence(db).pipe(
        Effect.catchCause((cause) => Effect.logWarning("Runtime fence heartbeat failed", cause)),
      )
      yield* heartbeat
        .pipe(Effect.repeat(Schedule.spaced(Duration.millis(HEARTBEAT_INTERVAL_MS))))
        .pipe(Effect.forkScoped)
    } else {
      yield* Effect.logWarning("Runtime fence claim failed — another runtime is alive").pipe(
        Effect.annotateLogs({ runtimeID: BackgroundJobStore.runtimeID() }),
      )
    }
    yield* Effect.addFinalizer(() =>
      BackgroundJobStore.releaseFence(db).pipe(
        Effect.catchCause((cause) => Effect.logWarning("Failed to release runtime fence on shutdown", cause)),
      ),
    )
    return Service.of({ claimed: Effect.succeed(claimed) })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
