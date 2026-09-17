export * as SessionWake from "./wake"

import { Context, Effect, Layer, PubSub, Scope, Stream } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { SessionSchema } from "./schema"

/**
 * Process-local advisory signal that a Session's durable inbox has new work to drain.
 *
 * Wakes are edge-triggered and coalescing: the durable inbox row remains the
 * truth, and a wake only causes a provider turn when the receiver can promote
 * eligible input. Nothing here is durable — a wake that is never delivered (or
 * a process that restarts) simply leaves the inbox row waiting, which is the
 * documented post-crash recovery boundary (`specs/v2/session.md`).
 *
 * The signal travels over one shared hub so that a Location-scoped publisher
 * (background-job completion delivery) can ask the process-global execution
 * coordinator to drain without depending on `SessionExecution`. Depending on
 * execution from the tool layer would close a layer cycle: execution resolves
 * the Location that owns the tool layer, so a Location-scoped dependency on
 * execution cannot be built. Publishing over this hub keeps the dependency
 * direction one-way: execution consumes wakes, publishers never see it.
 *
 * The hub is a plain process-wide `global` node. Wired beneath the application
 * root (any graph that provides `SessionExecution` pulls it in) it is built
 * once per process and shared with every Location; a graph that omits it
 * silently degrades to per-Location hubs without a subscriber, which is the
 * correct behavior when no execution coordinator exists.
 */
export interface Interface {
  /** Reports newly recorded durable inbox work. Repeated requests coalesce. */
  readonly request: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  /**
   * Creates one buffered subscription for a consumer. Subscribe while building
   * the consumer (not inside the fiber that reads it): a subscription buffers
   * requests published before the reader starts, so an early wake is delayed
   * rather than lost.
   */
  readonly subscribe: Effect.Effect<Stream.Stream<SessionSchema.ID>, never, Scope.Scope>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionWake") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const hub = yield* PubSub.unbounded<SessionSchema.ID>()
    yield* Effect.addFinalizer(() => PubSub.shutdown(hub))

    return Service.of({
      request: Effect.fn("SessionWake.request")(function* (sessionID: SessionSchema.ID) {
        yield* PubSub.publish(hub, sessionID)
      }),
      subscribe: PubSub.subscribe(hub).pipe(Effect.map((subscription) => Stream.fromSubscription(subscription))),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
