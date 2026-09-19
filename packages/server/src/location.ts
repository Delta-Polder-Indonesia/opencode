import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { LocationNotFoundError } from "@opencode-ai/protocol/errors"
import { Effect, Layer } from "effect"
import { stat } from "node:fs/promises"
import { HttpServerRequest } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"

export type LocationServices = Layer.Success<ReturnType<(typeof LocationServiceMap.Service)["get"]>>

export class LocationMiddleware extends HttpApiMiddleware.Service<LocationMiddleware, { provides: LocationServices }>()(
  "@opencode/HttpApiLocation",
  { error: LocationNotFoundError },
) {}

export function response<A, E, R>(data: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const location = yield* Location.Service
    return {
      location: new Location.Info({
        directory: location.directory,
        workspaceID: location.workspaceID,
        project: location.project,
      }),
      data: yield* data,
    }
  })
}

/**
 * A location only exists if its directory does.
 *
 * Every location service boots against the directory on disk, and
 * `FileSystem` resolves it with `realPath(...).pipe(Effect.orDie)`. For a
 * directory that is gone (a project folder deleted or renamed on the user's
 * machine), building the layer therefore dies with a `PlatformError: NotFound`
 * defect: the request is reported as `500 UnknownError`, the file search backend
 * logs a warning, and every retry repeats the whole cycle.
 *
 * Checking the directory before the layer is built turns that into one typed
 * 404 that no service has to boot for. Only "missing" errors are translated;
 * anything else (permissions, I/O) stays a defect exactly as before.
 */
export const ensureDirectory = (directory: string): Effect.Effect<void, LocationNotFoundError> =>
  Effect.callback<void, LocationNotFoundError>((resume) => {
    stat(directory).then(
      () => resume(Effect.succeed(undefined)),
      (cause) =>
        resume(
          missing(cause)
            ? Effect.fail(
                new LocationNotFoundError({
                  directory,
                  message: `Location directory not found: ${directory}`,
                }),
              )
            : Effect.die(cause),
        ),
    )
  })

function missing(cause: unknown) {
  const code = (cause as { code?: unknown } | undefined)?.code
  return code === "ENOENT" || code === "ENOTDIR"
}

function locationRef(request: HttpServerRequest.HttpServerRequest): Location.Ref {
  const query = new URL(request.url, "http://localhost").searchParams
  const workspaceID = query.get("location[workspace]") || request.headers["x-opencode-workspace"]
  const directory =
    query.get("location[directory]") ||
    (request.headers["x-opencode-directory"] ? decode(request.headers["x-opencode-directory"]) : process.cwd())
  return Location.Ref.make({
    directory: AbsolutePath.make(directory),
    workspaceID: workspaceID ? WorkspaceV2.ID.make(workspaceID) : undefined,
  })
}

function decode(input: string) {
  try {
    return decodeURIComponent(input)
  } catch {
    return input
  }
}

export const layer = Layer.effect(
  LocationMiddleware,
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    return LocationMiddleware.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const ref = locationRef(request)
        yield* ensureDirectory(ref.directory)
        return yield* effect.pipe(Effect.provide(locations.get(ref)))
      }),
    )
  }),
)
