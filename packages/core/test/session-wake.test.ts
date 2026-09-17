import { describe, expect } from "bun:test"
import { Context, Effect, Layer, LayerMap, Scope } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { makeGlobalNode, makeLocationNode, Node } from "@opencode-ai/core/effect/app-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { Location } from "@opencode-ai/core/location"
import type { LocationError, LocationServices } from "@opencode-ai/core/location-services"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionExecutionLocal } from "@opencode-ai/core/session/execution/local"
import { SessionRunner } from "@opencode-ai/core/session/runner"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionWake } from "@opencode-ai/core/session/wake"
import { testEffect } from "./lib/effect"

const sessionID = SessionV2.ID.make("ses_wake_test")
const missingID = SessionV2.ID.make("ses_wake_missing")
const projectID = Project.ID.global
const directory = AbsolutePath.make("/project")

const runs: { readonly sessionID: SessionV2.ID; readonly force: boolean }[] = []
const runner = Layer.succeed(
  SessionRunner.Service,
  SessionRunner.Service.of({
    run: (input) =>
      Effect.sync(() => {
        runs.push(input)
      }),
  }),
)

/**
 * The real executor resolves the owning Location through the map and runs that
 * Location's `SessionRunner`. This stub map hands every Location a recording
 * runner, so a drain is observable without building a full Location graph.
 */
const locations = Layer.effect(
  LocationServiceMap.Service,
  LayerMap.make((_ref: Location.Ref) => runner as unknown as Layer.Layer<LocationServices, never>),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, SessionStore.node, SessionWake.node, SessionExecution.node]),
    [
      [SessionExecution.node, SessionExecutionLocal.node],
      [LocationServiceMap.node, makeGlobalNode({ service: LocationServiceMap.Service, layer: locations, deps: [] })],
    ],
  ),
)

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: projectID, worktree: directory, sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: projectID,
      slug: "test",
      directory,
      title: "test",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

const pollRuns = (count: number, attempts = 500): Effect.Effect<void> =>
  runs.length >= count
    ? Effect.void
    : attempts <= 0
      ? Effect.void
      : Effect.sleep(1).pipe(Effect.andThen(pollRuns(count, attempts - 1)))

describe("SessionWake consumption", () => {
  it.live("drains an idle Session through its Location runner when woken", () =>
    Effect.gen(function* () {
      yield* setup
      runs.length = 0
      const wake = yield* SessionWake.Service

      yield* wake.request(sessionID)
      yield* pollRuns(1)

      expect(runs).toEqual([{ sessionID, force: false }])
    }),
  )

  it.live("ignores wakes for Sessions that do not exist", () =>
    Effect.gen(function* () {
      yield* setup
      runs.length = 0
      const wake = yield* SessionWake.Service

      yield* wake.request(missingID)
      yield* Effect.sleep(50)

      expect(runs).toEqual([])
    }),
  )
})

/* ------------------------------------------------------------------------- */
/* A Location-scoped publisher must reach the application-level subscriber.   */
/* That only holds while the hub is one shared instance per process, so pin   */
/* the two facts the wiring relies on: root-anchored globals are shared with  */
/* Location trees, and Location-only globals are not.                         */
/* ------------------------------------------------------------------------- */

class WakeConsumer extends Context.Service<WakeConsumer, SessionWake.Interface>()("@test/WakeConsumer") {}

class Lonely extends Context.Service<Lonely, { readonly id: number }>()("@test/Lonely") {}

const lonelyBuilds: number[] = []
const lonelyNode = makeGlobalNode({
  service: Lonely,
  layer: Layer.effect(
    Lonely,
    Effect.sync(() => {
      const id = lonelyBuilds.length + 1
      lonelyBuilds.push(id)
      return { id }
    }),
  ),
  deps: [],
})

class LonelyProbe extends Context.Service<LonelyProbe, { readonly id: number }>()("@test/LonelyProbe") {}

/** Root-anchored global: reachable from the application root and a Location tree. */
const consumer = makeLocationNode({
  service: WakeConsumer,
  layer: Layer.effect(WakeConsumer, SessionWake.Service),
  deps: [SessionWake.node],
})

/** Location-only global: reachable exclusively through a Location tree. */
const lonelyProbe = makeLocationNode({
  service: LonelyProbe,
  layer: Layer.effect(LonelyProbe, Lonely.pipe(Effect.map((lonely) => ({ id: lonely.id })))),
  deps: [lonelyNode],
})

/** Replica of `buildLocationServiceMap` over a two-node Location tree. */
const locationMap = Layer.effect(
  LocationServiceMap.Service,
  LayerMap.make((_ref: Location.Ref) => {
    const hoisted = LayerNode.hoist(LayerNode.group([consumer, lonelyProbe]), Node.tags.values.global)
    return LayerNode.compile(hoisted.node).pipe(Layer.fresh, Layer.provide(LayerNode.compile(hoisted.hoisted)))
  }) as unknown as Effect.Effect<LayerMap.LayerMap<Location.Ref, LocationServices, LocationError>, never, Scope.Scope>,
)

const shared = testEffect(
  AppNodeBuilder.build(LayerNode.group([SessionWake.node, LocationServiceMap.node]), [
    [LocationServiceMap.node, makeGlobalNode({ service: LocationServiceMap.Service, layer: locationMap, deps: [] })],
  ]),
)

const refA = Location.Ref.make({ directory: AbsolutePath.make("/tmp/session-wake-a"), workspaceID: undefined })
const refB = Location.Ref.make({ directory: AbsolutePath.make("/tmp/session-wake-b"), workspaceID: undefined })

describe("SessionWake hub", () => {
  shared.live("shares the hub between the application root and Location trees", () =>
    Effect.gen(function* () {
      const appWake = yield* SessionWake.Service
      const locations = yield* LocationServiceMap.Service

      const a = yield* WakeConsumer.pipe(Effect.provide(locations.get(refA) as unknown as Layer.Layer<WakeConsumer>))
      const b = yield* WakeConsumer.pipe(Effect.provide(locations.get(refB) as unknown as Layer.Layer<WakeConsumer>))

      expect(a).toBe(appWake)
      expect(b).toBe(appWake)
    }),
  )

  shared.live("isolates globals that are only reachable through Location trees", () =>
    Effect.gen(function* () {
      const locations = yield* LocationServiceMap.Service

      const a = yield* LonelyProbe.pipe(Effect.provide(locations.get(refA) as unknown as Layer.Layer<LonelyProbe>))
      const b = yield* LonelyProbe.pipe(Effect.provide(locations.get(refB) as unknown as Layer.Layer<LonelyProbe>))

      expect(a.id).not.toBe(b.id)
    }),
  )
})
