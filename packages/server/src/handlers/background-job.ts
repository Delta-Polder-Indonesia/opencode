import { BackgroundJobStore } from "@opencode-ai/core/background-job/store"
import { Database } from "@opencode-ai/core/database/database"
import { JobNotFoundError } from "@opencode-ai/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

/**
 * Durable V2 background job observation (gate 3). Read-only and instance-wide
 * by contract: rows are the restart-time truth, the live registry is not
 * consulted. See the authorization decision in specs/v2/background-jobs.md.
 */
export const JobHandler = HttpApiBuilder.group(Api, "server.job", (handlers) =>
  Effect.gen(function* () {
    const database = yield* Database.Service

    return handlers
      .handle(
        "job.list",
        Effect.fn(function* (ctx) {
          return {
            data: yield* BackgroundJobStore.list(database.db, {
              sessionID: ctx.query.sessionID,
              status: ctx.query.status,
              limit: ctx.query.limit,
            }),
          }
        }),
      )
      .handle(
        "job.get",
        Effect.fn(function* (ctx) {
          const info = yield* BackgroundJobStore.get(database.db, ctx.params.jobID)
          if (!info) {
            return yield* Effect.fail(
              new JobNotFoundError({
                jobID: ctx.params.jobID,
                message: `Background job not found: ${ctx.params.jobID}`,
              }),
            )
          }
          return { data: info }
        }),
      )
      .handle(
        "job.cancel",
        Effect.fn(function* (ctx) {
          const result = yield* BackgroundJobStore.requestCancel(database.db, ctx.params.jobID)
          if (result._tag === "NotFound") {
            return yield* Effect.fail(
              new JobNotFoundError({
                jobID: ctx.params.jobID,
                message: `Background job not found: ${ctx.params.jobID}`,
              }),
            )
          }
          return {
            data: result.info,
            requested: result._tag === "Requested",
            stale_owner: result._tag === "StaleOwner",
          }
        }),
      )
  }),
)
