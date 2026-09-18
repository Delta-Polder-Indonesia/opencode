export * as SessionRecovery from "./recovery"

import { Context, Effect, Layer } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { SessionSchema } from "./schema"
import { SessionRecoveryStore } from "./recovery/store"

export type { Discovery, Info, RetryResult } from "./recovery/store"
export * from "./recovery/store"

export interface Interface {
  /** Runs non-executing startup discovery once for the process root. */
  readonly discovered: Effect.Effect<ReadonlyArray<SessionRecoveryStore.Discovery>>
  readonly list: (sessionID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<SessionRecoveryStore.Info>>
  readonly retry: (id: string, confirmAmbiguous?: boolean) => Effect.Effect<SessionRecoveryStore.RetryResult>
  readonly abandon: (id: string) => Effect.Effect<SessionRecoveryStore.Info | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionRecovery") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const discovered = yield* SessionRecoveryStore.discover(db)
    if (discovered.length > 0)
      yield* Effect.logInfo("Discovered provider attempts requiring continuation recovery").pipe(
        Effect.annotateLogs({ count: discovered.length }),
      )
    return Service.of({
      discovered: Effect.succeed(discovered),
      list: (sessionID) => SessionRecoveryStore.list(db, sessionID),
      retry: (id, confirmAmbiguous) => SessionRecoveryStore.retry(db, id, confirmAmbiguous),
      abandon: (id) => SessionRecoveryStore.abandon(db, id),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
