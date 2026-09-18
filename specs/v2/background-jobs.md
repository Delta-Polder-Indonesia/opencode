# V2 Background Jobs over Tool Execution

Status: gates 1–3 are implemented. Live completion delivery uses the shared
SessionWake hub, restart recovery is queue-only and silent, and the current
slice adds lease/heartbeat fencing plus the HTTP cancel mutation. Supersedes
the "integrate the new BackgroundJob service with V2 tool execution" entry in
`todo.md`. This document is the design contract; keep the remaining-slices
section accurate as follow-ups land.

## Problem

V2 tool execution settles every call inline: the runner forks
`toolMaterialization.settle(...)` per tool call and awaits all settlements
before the provider turn closes (`session/runner/llm.ts`). Long-running shell
work therefore blocks a turn until it finishes or hits the 10 minute
`MAX_TIMEOUT_MS` cap. The legacy background bash mode was removed from V2 with
three explicit re-introduction gates (`tool/bash.ts`):

1. persist background job status and define restart recovery before remote
   observation,
2. re-add model-facing background launch only with owner-bound
   get/wait/cancel tools and completion delivery,
3. add HTTP background-job observation only after durable status, restart
   recovery, and authorization are defined.

Gate 2 landed first (model-facing launch + owner-bound observation + inbox
completion delivery). Gate 1 landed next and is specified below. Gate 3 is
specified in "HTTP observation (gate 3)" below.

## Model contract

### bash gains `background?: boolean`

- Default unchanged: unset/`false` runs the command inline and returns
  `{ exit?, truncated, timeout?, output, warnings? }` exactly as before.
- `background: true` performs the same permission assertion (`bash` action on
  the command resource, plus external-directory checks) and then hands the
  command to the `BackgroundJob` registry instead of awaiting it. The call
  settles immediately with `job` (the registry job id) in the structured
  output and a model-readable pointer to the job tools.
- The timeout still bounds each background run (default 2 minutes, max 10
  minutes). Background execution is about not blocking the turn, not about
  unbounded runtime.

### Owner-bound job tools: `job_get`, `job_wait`, `job_cancel`

Registered by `tool/job.ts` next to the other built-ins
(`tool/builtins.ts`).

- Ownership is the originating session: the launcher stores `sessionID`,
  `agent`, `assistantMessageID`, `toolCallID`, `command`, and `directory` on
  the job metadata, and every job tool rejects a job whose metadata belongs
  to a different session with an "Unknown job" failure. Cross-session
  observation is deliberately indistinguishable from absence. The durable
  store honors the same rule: persisted rows owned by other sessions are
  invisible.
- The tools consult the live registry first and fall back to the durable
  store. After a restart the registry is empty, so `job_get` on a previous
  process's job answers from the persisted row instead of "Unknown job".
- `job_get` returns the current status snapshot (`running | completed |
error | cancelled`, plus `interrupted` for rows claimed by restart recovery)
  with output or error when settled.
- `job_wait` blocks up to `timeout` ms (default 30s, max 300s) for
  completion, returning `{ timedOut }` explicitly so the model can choose to
  keep polling, keep working, or cancel. A job that is already settled —
  live or persisted — returns immediately with `timedOut: false`.
- `job_cancel` interrupts the job's scope. Cancellation is terminal and
  never generates an inbox note (the cancelling actor already knows).
  Cancelling an already-settled persisted row is a no-op returning the row.

### Completion delivery through the session inbox

When a background job finishes with `completed`, `error`, or `interrupted`,
the launcher admits a durable session input (`SessionInput.admit`, the exact
path user prompts use) containing a short note: job id, command, status,
exit/error line, and an output preview (last ~1.5 KB; full output via
`job_get`). The note is a real `PromptAdmitted` event either way, so it is
durably recorded once and, once promoted, becomes an ordinary visible user
message.

Live settlement delivery then asks for execution:

- The note is admitted with `steer` delivery, so an **active** drain promotes
  it at its next safe provider-turn boundary instead of waiting for the run to
  go idle (or for the next user turn).
- The launcher also publishes a process-local advisory wake. An **idle**
  session resumes: the runner drains, promotes eligible input, and still only
  reaches a provider when the note (or other pending input) is promotable.

The wake is deliberately neither a durable/public event nor a tool-layer
dependency on `SessionExecution`. Depending on execution from a tool would
close a layer cycle (runner → tool registry → bash → execution → runner)
because execution resolves the owning Location. Instead the tool layer
publishes on a process-global `SessionWake` hub
(`packages/core/src/session/wake.ts`), and the root-level
`SessionExecutionLocal` subscribes and forwards wakes to its coordinator.
The hub is an ordinary global node: one shared instance per process, reachable
from Location trees because the execution node also depends on it. A graph
that never provides execution simply has no subscriber. Wakes are
edge-triggered and coalescing; the durable note remains the truth, so a
dropped wake degrades to the previous behavior.

Restart recovery is deliberately different: claimed rows are delivered with
`queue` delivery and **no** wake. A process that just booted does not schedule
provider work for its recovery notes; the session learns the job's fate on its
next activity. Recovery notes are still delivered
for jobs claimed as `interrupted` (see below), so the fate is never lost
across a process crash. Provider-attempt startup discovery is a separate,
non-executing root service described in `specs/v2/session-recovery.md`; it does
not turn this job-note delivery into provider replay.

## Durable status (gate 1)

### Persistence contract

Tool-launched jobs persist to the `background_job` table in the (global)
SQLite database:

| column                         | content                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------- |
| `id`                           | job id (primary key)                                                                              |
| `type`                         | launcher type, e.g. `bash`                                                                        |
| `title`                        | display title (command preview)                                                                   |
| `session_id`                   | owning session (FK → `session`, cascade delete), indexed with `status`                            |
| `status`                       | `running`, `completed`, `error`, `cancelled`, or `interrupted`                                    |
| `runtime_id`                   | per-process marker of the runtime that started or currently owns the row; never a fence by itself |
| `fence`                        | monotonic compare-and-set ownership token                                                         |
| `heartbeat_at` / `lease_until` | owner heartbeat and expiry epoch millis                                                           |
| `cancel_requested_at`          | durable remote-cancel request observed by the live owner heartbeat                                |
| `started_at` / `completed_at`  | epoch millis                                                                                      |
| `output`                       | bounded tail of the settled output (last 16 KB, `…`-prefixed when truncated)                      |
| `error`                        | settled error text, or the recovery message                                                       |
| `metadata`                     | the owner metadata JSON exactly as stored on the registry job                                     |

Write path:

- `JobTool.launch` inserts the `running` row after `BackgroundJob.start`
  succeeds (a failed start never leaves an orphan row) and before forking
  the completion watcher.
- The completion watcher persists the terminal status **before** admitting
  the inbox note. A crash between job end and persistence therefore recovers
  as `interrupted` with an unknown outcome — honest, since the process that
  observed the outcome is gone.
- Persistence is best-effort with respect to launch: an insert/update
  failure logs and continues. A job is never lost, blocked, or hidden from
  live observation because durability is unavailable; it simply degrades to
  process-local semantics for that row.

`interrupted` is produced **only** by restart recovery; the live registry
never settles to it. The registry itself stays intentionally in-memory and
process-local — durability is layered around it, not inside it.

### Runtime identity, process fence, and restart recovery

Each process generates one ascending `runtime_…` identifier. In addition to the
per-job lease, the process-global `runtime_fence` row tracks liveness through a
heartbeat. The `RuntimeFence` global node claims the row at boot, renews it
every 10 seconds, and releases it on clean shutdown; a crashed runtime leaves
an old heartbeat that expires after `FENCE_TTL_MS = 30_000`. A runtime that
finds another live process fence does not use that live fence as evidence that
foreign jobs are stale. This global liveness signal narrows recovery; the
per-row `(runtime_id, fence, lease_until)` capability remains the authoritative
write boundary.

Each running row also carries a monotonic `fence`, `heartbeat_at`, and
`lease_until` capability.
`runtime_id` is an audit marker; it is never accepted as a fence by itself.
The owner renews the lease from the long-lived watcher. Every settlement,
heartbeat, and cancellation acknowledgement checks `(id, status, runtime_id,
fence)` and an unexpired lease. A later owner increments `fence`, so an old
runtime can finish its local child process but cannot change durable status or
deliver a stale completion.

Recovery is invoked as each Location's long-lived job-tool layer initializes;
repeated invocations are harmless because the durable claim is atomic. It claims every row that satisfies **all**: `status = running`, the
`runtime_id` differs from the current process, `lease_until` is absent or
expired, and the owning process fence is expired or missing. A live
`runtime_fence` heartbeat therefore prevents recovery even when a job lease
has reached its boundary. Each claim is an atomic guarded `UPDATE … RETURNING`, setting
`status = interrupted`, `completed_at = now`, `error = "Process exited while
this job was running; its outcome is unknown."`, clearing the lease, and
incrementing `fence`. Rows with a live heartbeat are never touched, even when
another runtime starts against the same database. Rows belonging to the
current runtime are not recovered during the same process (which keeps
Location rebuilds idempotent), and settled rows are never reopened.

A remote cancel is deliberately two-phase: while the lease is live, HTTP
records `cancel_requested_at` and returns `{ requested: true }`; the owner
observes that bit on its next heartbeat and interrupts its local registry job.
The response does **not** claim that the remote process has already stopped.
When the lease is expired, the API fences the row and returns
`{ stale_owner: true }` with `interrupted`/unknown status instead of falsely
returning `cancelled`. This is the mutation boundary that makes clustered
observation safe.

For each claimed row whose owning session still exists, recovery admits the
same durable queue-delivery completion note the live watcher would have
delivered (skipped for deleted sessions and rows without owner metadata;
claim and delivery are independent — a delivery failure never unclaims the
row).

### Semantics guarantees (and non-guarantees)

- Claims and mutations are lease/fence guarded. Two runtimes may observe the
  same expired row, but only the compare-and-set update that still matches its
  `(id, status, runtime_id, fence)` can win. A winner increments the fence;
  stale settlement, heartbeat, and cancellation acknowledgements become
  no-ops. `runtime_id` alone is never a safety boundary.
- The durable row is the restart-time truth; the live registry remains the
  live-time truth. A live `job_get` always prefers the registry, so full
  in-memory output stays available for the process lifetime even though the
  row only retains a bounded tail. After a restart, `job_get` returns the
  persisted tail (or the recovery error) instead.
- Launch is synchronous within the settle: `BackgroundJob.start` publishes
  the job before forking, so a race where the job completes before the model
  learns its id cannot produce a lost note — the completion watcher runs
  after `start` returns.
- Turn interruption does not cancel background jobs: they live in the global
  process-local registry scope, not in the per-turn tool `FiberSet`. The
  explicit control surface is `job_cancel`.
- The completion watcher lives in the Location scope of the tool layer, so
  it survives the settling fiber but dies with the process, matching the
  registry's lifetime; recovery is what repairs the loss.
- Job output preview in the note is best-effort: the full string output is
  retained by the registry for the process lifetime, the durable row retains
  the bounded tail.

## HTTP observation (gate 3)

### Authorization decision (explicit)

Job observation over HTTP is **instance-wide**: any authenticated consumer of
the instance API may list and read every durable background job, including
its owner metadata and output tail. Owner-bound hiding (cross-session jobs
indistinguishable from absence) remains a **model-facing-only** property of
the `job_*` tools and is deliberately not replicated at the HTTP layer.

Rationale:

- **V1 precedent**: the legacy experimental handler observes the instance
  registry without per-session authorization (`sessionBackground` lists all
  jobs and filters by `parentSessionId` client-side). There is no existing
  HTTP surface where one consumer sees less session data than another.
- **The rest of the V2 surface already exposes everything an owner-hiding
  rule would protect**: any authenticated consumer can read a session's full
  history, messages, and tool I/O via `/api/session/:id/...`. Hiding a job
  row behind per-session authorization there would add inconsistency and a
  false sense of confinement, not a real boundary.
- **What owner-hiding actually protects** is the _model surface_: one
  session's context window must not learn another session's jobs (nor can it
  probe for them, since `job_get` answers "Unknown job"). That property lives
  entirely in the tool layer and is unchanged by this gate.

Corollaries: the authorization boundary for jobs is the instance's existing
API authentication (same as every other route), not session membership.
Rows of deleted sessions disappear by the FK cascade — observation of a
deleted session's jobs ends with the session, matching the recovery rule
that skips deliveries to deleted sessions.

### Contract

The durable store is mounted on the V2 protocol surface (group
`server.job`):

- `GET /api/job` (`v2.job.list`) — list durable job rows, newest first
  (`started_at` desc, `id` desc as tiebreak). Query: optional `sessionID`
  (owner session filter, uses the `(session_id, status)` index), optional
  `status` literal filter, optional `limit` (default 50). Response
  `{ data: BackgroundJobInfo[] }`.
- `GET /api/job/:jobID` (`v2.job.get`) — one durable row, or 404
  `JobNotFoundError` when no row has that id.
- `POST /api/job/:jobID/cancel` (`v2.job.cancel`) — for a live lease, records
  `cancel_requested_at` and returns `{ requested: true, stale_owner: false }`.
  The owner heartbeat observes the request and interrupts its local registry
  job; the HTTP response never claims that the process has already stopped.
  For an expired or missing lease, the handler atomically increments the
  fence, records `interrupted` with an unknown-outcome error, and returns
  `{ requested: false, stale_owner: true }`. Already-settled rows are returned
  unchanged with both flags false. `JobNotFoundError` remains the 404 result
  for an unknown id.

The wire shape mirrors the model-facing job tools (`id`, `type`, `title`,
`status` including `interrupted`, `started_at`, `completed_at`, `output`,
`error`) plus `session_id`, `metadata`, and the durable
`cancel_requested_at` marker, so an app can render the same object a model
sees. Output is always bounded by the same 16 KB tail the store persists —
the HTTP surface observes durable truth, not the registry's unbounded
in-memory text.

**Truth source is the durable row, not the live registry.** The registry is
process- and Location-scoped, so rows are the only observation source that
means the same thing from every process, after restarts, and across Location
rebuilds. Consequences, all within the existing best-effort durability
contract:

- a `running` row is live truth for "some runtime started this job";
  a job whose settlement has not been persisted yet (or whose persistence
  failed — logged, never blocking) may briefly or persistently read as
  `running` after it actually finished remotely, exactly as it does to
  restart recovery;
- a job whose launch-row insert failed is invisible to HTTP observation and
  HTTP mutation while remaining fully visible model-facing for its process
  lifetime — the documented degrade-to-process-local path;
- full live output is a model-facing registry feature; remote consumers get
  the durable tail.

The cancellation mutation waits for the lease/fence decision before returning
and never pretends that a stale runtime was stopped. There is no HTTP `wait`
mutation: clients observe the durable row after requesting cancellation.

V1 jobs stay out of this namespace by design: the legacy experimental
surface continues to observe only V1 registry jobs, and `/api/job` exposes
only V2 durable rows.

## Verification

Unit/integration coverage in `packages/core/test/`:

- `tool-bash.test.ts`
  - background launch settles without waiting for the process (blocking
    mock proves the settle returns while the command is still running),
    exposes `job` in output + structured output, and asserts the same
    permission inputs as the inline path,
  - the running job is observable through the real `BackgroundJob` registry
    and completes with formatted `exit N` output,
  - inline path unchanged (existing assertions, schema now includes the
    documented `background` property).
- `tool-job.test.ts`
  - `job_get` returns owner-session jobs and hides foreign jobs as
    "Unknown job" (live **and** persisted rows),
  - `job_wait` returns `timedOut: true` for unfinished jobs, resolves with
    output after completion, and returns settled persisted rows immediately,
  - `job_cancel` transitions the job to `cancelled` and releases waiters,
  - live completion delivery appears as a pending steer-delivery session
    input via `SessionInput.find`, requests exactly one wake for the owner
    session, and cancelled jobs deliver nothing and never wake,
  - launch persists a `running` row and settlement persists status, bounded
    output tail, and completion time; cancellation persists `cancelled`,
  - recovery claims expired foreign-runtime `running` rows as `interrupted`,
    leaves live-heartbeat, current-runtime, and settled rows untouched,
    increments the fence, delivers a queue note (with no wake) for existing
    owner sessions, skips deleted sessions, and the claimed job becomes
    observable through `job_get` with an empty registry,
  - a live HTTP-style cancel records a request for the owner heartbeat, an
    expired owner is fenced as interrupted, and stale settlement is rejected,
  - `BackgroundJobStore.list` orders newest-first, and filters by owner
    session, status, and limit.
- `session-recovery.test.ts`
  - preparation-only loss becomes retry-ready and consumes at most one safe
    automatic retry after backoff,
  - dispatched ambiguity is fenced, visible, and confirmation-gated before
    explicit retry,
  - an expired Session lease can be acquired by a new runtime with an
    incremented fence.
- `session-wake.test.ts`
  - a wake drains an idle Session through its Location's `SessionRunner`, and
    wakes for Sessions that no longer exist are ignored,
  - the hub is one shared instance between the application root and Location
    trees, while a global reachable only through a Location tree stays
    per-Location (the property the wiring depends on).
- `httpapi-exercise` route coverage:
  - `v2.job.list` returns seeded durable rows newest-first and honors the
    `sessionID` filter,
  - `v2.job.get` returns one seeded row and answers 404 `JobNotFoundError`
    for unknown ids,
  - `v2.job.cancel` exercises both the live-owner request and expired-owner
    fencing paths,
  - `v2.session.recovery.list`, `.retry.confirmation-required`, `.retry`, and
    `.abandon` exercise durable recovery visibility and explicit decisions.
- Generated V2 SDK types and operations are regenerated from the route
  contract; generated OpenAPI/config/lock artifacts remain local and are not
  committed.

Core typecheck (`packages/core`, tsgo) must pass; the full
`packages/opencode` typecheck does not fit the ~3.9 GB sandbox (baseline
already takes ~700 s and is OOM-prone) and is intentionally not gating here.

## Remaining slices

- **Background agent dispatch**: the `job_*` tools are agent-dispatch ready
  (ownership + wait/cancel are dispatch-agnostic), but a V2 sub-agent tool
  does not exist in core yet; port `task` from the app package first
  (listed in `tool/builtins.ts` TODO).
- Longer-running jobs beyond `MAX_TIMEOUT_MS` need a persistent-job concept
  that survives restart _and_ re-executes; deliberately out of scope —
  recovery records the loss, it does not replay the work.
