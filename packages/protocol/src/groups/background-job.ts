import { PositiveInt } from "@opencode-ai/schema/schema"
import { Session } from "@opencode-ai/schema/session"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { JobNotFoundError } from "../errors"

/**
 * Durable V2 background job observation (gate 3). Read-only, instance-wide:
 * see the authorization decision in specs/v2/background-jobs.md. Rows are the
 * restart-time truth; a live process may hold fresher model-facing state that
 * this surface intentionally does not expose.
 */
export const BackgroundJobStatus = Schema.Literals(["running", "completed", "error", "cancelled", "interrupted"])

export const BackgroundJobInfo = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  status: BackgroundJobStatus,
  title: Schema.optional(Schema.String),
  session_id: Session.ID.pipe(Schema.optional),
  started_at: Schema.Number,
  completed_at: Schema.optional(Schema.Number),
  output: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
}).annotate({ identifier: "BackgroundJobInfo" })

export const JobListQuery = Schema.Struct({
  sessionID: Session.ID.pipe(Schema.optional),
  status: BackgroundJobStatus.pipe(Schema.optional),
  limit: PositiveInt.pipe(Schema.optional),
})

export const JobGroup = HttpApiGroup.make("server.job")
  .add(
    HttpApiEndpoint.get("job.list", "/api/job", {
      query: JobListQuery,
      success: Schema.Struct({ data: Schema.Array(BackgroundJobInfo) }),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.job.list",
        summary: "List background jobs",
        description:
          "List durable V2 background job rows, newest first. Observation is instance-wide and read-only; output is the persisted 16 KB tail. Jobs of deleted sessions are removed by cascade.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("job.get", "/api/job/:jobID", {
      params: { jobID: Schema.String },
      success: Schema.Struct({ data: BackgroundJobInfo }),
      error: JobNotFoundError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.job.get",
        summary: "Get a background job",
        description: "Read one durable V2 background job row, or answer 404 when no row has that id.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "jobs",
      description: "Read-only observation of durable V2 background jobs.",
    }),
  )
