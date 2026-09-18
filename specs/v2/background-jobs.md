# V2 Background Jobs over Tool Execution

Status: gates 1+2 implemented (gate 2 on branch `arena/01a0b0bc-opencode`,
gate 1 on branch `arena/01a0b171-opencode`); gate 3 (HTTP observation) is
specified below and implemented on `arena/01a0b189-opencode`; auto-resume on
completion delivery implemented on `arena/01a0b19d-opencode`; stale-owner
fencing implemented on `arena/01a0b1cd-opencode`. Supersedes the
"integrate the new BackgroundJob service with V2 tool execution" entry in
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
next activity, and startup discovery belongs to the deferred
continuation-recovery slice in `todo.md`. Recovery notes are still delivered
for jobs claimed as `interrupted` (see below), so the fate is never lost
across a process crash.

## Durable status (gate 1)

### Persistence contract

Tool-launched jobs persist to the `background_job` table in the (global)
SQLite database:

| column                        | content                                                                      |
| ----------------------------- | ---------------------------------------------------------------------------- |
| `id`                          | job id (primary key)                                                         |
| `type`                        | launcher type, e.g. `bash`                                                   |
| `title`                       | display title (command preview)                                              |
| `session_id`                  | owning session (FK → `session`, cascade delete), indexed with `status`       |
| `status`                      | `running`, `completed`, `error`, `cancelled`, or `interrupted`               |
| `runtime_id`                  | per-process marker of the runtime that started the row                       |
| `started_at` / `completed_at` | epoch millis                                                                 |
| `output`                      | bounded tail of the settled output (last 16 KB, `…`-prefixed when truncated) |
| `error`                       | settled error text, or the recovery message                                  |
| `metadata`                    | the owner metadata JSON exactly as stored on the registry job                |

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

### Runtime identity, restart recovery, and stale-owner fencing

Each process generates one ascending `runtime_…` identifier. A
`runtime_fence` table (one row per active runtime) tracks liveness via
periodic heartbeats. On boot the `RuntimeFence` service atomically claims
the fence row (insert if absent, overwrite if the previous owner's fence
has expired, fail if another runtime holds a live fence). The heartbeat
fiber renews the fence every 10 seconds; the row is released on clean
shutdown. See `packages/core/src/runtime-fence.ts` and
`packages/core/src/background-job/store.ts`.

Recovery runs once per Location service boot inside the `tool/job` node
(before any tool can execute) and claims every row that satisfies **all
three**:

1. `status = running`
2. `runtime_id` differs from the current process
3. the owning runtime's fence has expired (age > 30 s), **or** no fence
   row exists for that runtime (pre-fence migrations, or clean shutdown
   that released the fence)

Each claim is an atomic `UPDATE … WHERE id = ? AND status = 'running'
RETURNING`, setting `status = interrupted`, `completed_at = now`, and
`error = "Process exited while this job was running; its outcome is
unknown."` Rows belonging to the current runtime are never touched (this
also makes recovery idempotent across Location rebuilds within one process),
and settled rows are never reopened.

For each claimed row whose owning session still exists, recovery admits the
same durable queue-delivery completion note the live watcher would have
delivered (skipped for deleted sessions and rows without owner metadata;
claim and delivery are independent — a delivery failure never unclaims the
row).

### Stale-owner fencing (detailed)

The `runtime_fence` table has two columns:

| column         | content                                                        |
| -------------- | -------------------------------------------------------------- |
| `runtime_id`   | process-local ascending identifier (primary key)               |
| `heartbeat_at` | epoch millis of the last heartbeat renewal                     |

Constants:

- `FENCE_TTL_MS = 30_000` — a fence row is considered expired when
  `now - heartbeat_at > FENCE_TTL_MS`.
- `HEARTBEAT_INTERVAL_MS = 10_000` — the heartbeat fiber renews the row
  every 10 seconds, so one missed heartbeat does not expire the fence
  (three consecutive failures would be needed).

Lifecycle:

1. **Boot**: `RuntimeFence` (global node, depends on `Database`) calls
   `claimFence`. If no row exists, inserts one; if the existing row
   belongs to another runtime and is expired, overwrites it; if the
   existing row is live, returns `false` and logs a warning (the caller
   decides whether to retry or proceed without recovery). The fence
   claim **must** succeed before `BackgroundJobStore.insert` or
   `recover` can run safely.
2. **Heartbeat**: a `forkScoped` fiber runs `heartbeatFence` every 10
   seconds. Failures are logged but never crash the process.
3. **Shutdown**: the finalizer calls `releaseFence` (DELETE the row),
   so the next boot sees no row and claims immediately.
4. **Crash**: no release runs; the row persists with a stale
   `heartbeat_at`. After `FENCE_TTL_MS` the next boot overwrites it.

`JobTool.node` depends on `RuntimeFence.node`, so the fence is always
claimed before recovery runs. The `RuntimeFence` node is global and
anchored at the application root, so exactly one heartbeat fiber runs
per process regardless of how many Location trees are built.

### Semantics guarantees (and non-guarantees)

- Single-writer assumption with fence safety: the fence prevents
  recovery from claiming rows owned by a runtime that is still
  heartbeating. Without the fence, recovery would claim any foreign
  `runtime_id` row — even one owned by a live process. With the fence,
  recovery only claims rows whose owner's heartbeat has expired (or rows
  with no fence at all, which are safe under the single-writer
  assumption). Two processes against one SQLite database can still race
  on claims if the fence-claim sequence is not atomic at the database
  level; this is the same class as the existing migration-claiming debt
  in `todo.md`.
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

Two read-only routes on the durable store, mounted on the V2 protocol
surface (group `server.job`):

- `GET /api/job` (`v2.job.list`) — list durable job rows, newest first
  (`started_at` desc, `id` desc as tiebreak). Query: optional `sessionID`
  (owner session filter, uses the `(session_id, status)` index), optional
  `status` literal filter, optional `limit` (default 50). Response
  `{ data: BackgroundJobInfo[] }`.
- `GET /api/job/:jobID` (`v2.job.get`) — one durable row, or 404
  `JobNotFoundError` when no row has that id.

The wire shape mirrors the model-facing job tools (`id`, `type`, `title`,
`status` including `interrupted`, `started_at`, `completed_at`, `output`,
`error`) plus `session_id` and `metadata`, so an app can render the same
object a model sees. Output is always bounded by the same 16 KB tail the
store persists — the HTTP surface observes durable truth, not the
registry's unbounded in-memory text.

**Truth source is the durable row, not the live registry.** The registry is
process- and Location-scoped, so rows are the only observation source that
means the same thing from every process, after restarts, and across
Location rebuilds. Consequences, all within the existing best-effort
durability contract:

- a `running` row is live truth for "some runtime started this job";
  a job whose settlement has not been persisted yet (or whose persistence
  failed — logged, never blocking) may briefly or persistently read as
  `running` after it actually finished remotely, exactly as it does to
  restart recovery;
- a job whose launch-row insert failed is invisible to HTTP observation
  while remaining fully visible model-facing for its process lifetime —
  the documented degrade-to-process-local path;
- full live output is a model-facing registry feature; remote consumers get
  the durable tail.

Mutation (cancel/wait over HTTP) is deliberately out of scope: gate 3 is
observation. Cross-process control would need the stale-owner fencing slice
first (cancelling a `running` row owned by a dead runtime must not pretend
to stop anything).

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
  - recovery claims foreign-runtime `running` rows as `interrupted`, leaves
    current-runtime and settled rows untouched, delivers a queue note (with
    no wake) for existing owner sessions, skips deleted sessions, and the
    claimed job becomes observable through `job_get` with an empty registry,
  - `BackgroundJobStore.list` orders newest-first, and filters by owner
    session, status, and limit.
- `session-wake.test.ts`
  - a wake drains an idle Session through its Location's `SessionRunner`, and
    wakes for Sessions that no longer exist are ignored,
  - the hub is one shared instance between the application root and Location
    trees, while a global reachable only through a Location tree stays
    per-Location (the property the wiring depends on).
- `runtime-fence.test.ts`
  - `claimFence` succeeds when no fence exists, succeeds idempotently for
    the same runtime, fails when another runtime holds a live fence, and
    succeeds when the existing fence has expired,
  - `heartbeatFence` renews the fence timestamp,
  - `releaseFence` removes the fence row,
  - `fenceAge` returns `null` for non-existent fences and the correct age
    for existing fences,
  - recovery claims rows whose owning runtime fence has expired, skips rows
    whose owning runtime fence is still live, claims rows with no fence row
    (pre-fence migration / clean shutdown), skips current-runtime rows
    regardless of fence state, and handles mixed fences correctly.
- `httpapi-exercise` route coverage:
  - `v2.job.list` returns seeded durable rows newest-first and honors the
    `sessionID` filter,
  - `v2.job.get` returns one seeded row and answers 404 `JobNotFoundError`
    for unknown ids.

Core typecheck (`packages/core`, tsgo) must pass; the full
`packages/opencode` typecheck does not fit the ~3.9 GB sandbox (baseline
already takes ~700 s and is OOM-prone) and is intentionally not gating here.

## Remaining slices

- **Continuation-recovery policy**: inbox-driven resume landed here (idle
  sessions wake, active drains steer at the next provider-turn boundary), but
  the wake stays advisory and never re-dispatches an interrupted provider
  attempt. Provider-attempt preparation versus dispatch ambiguity, explicit
  `retry`/`abandon` decisions for unknown outcomes, retry budget/backoff,
  visible recovery status, and startup discovery remain deferred to the slice
  described in `specs/v2/todo.md`.
- **HTTP mutation (cancel over API)**: read-only observation landed with
  gate 3; stale-owner fencing now protects recovery from claiming live
  runtimes' rows. Cross-process cancel over HTTP is the next mutation
  slice — the fence provides the necessary ownership verification so
  cancelling a `running` row can check whether the owner is actually
  alive.
- **Background agent dispatch**: the `job_*` tools are agent-dispatch ready
  (ownership + wait/cancel are dispatch-agnostic), but a V2 sub-agent tool
  does not exist in core yet; port `task` from the app package first
  (listed in `tool/builtins.ts` TODO).
- Longer-running jobs beyond `MAX_TIMEOUT_MS` need a persistent-job concept
  that survives restart _and_ re-executes; deliberately out of scope —
  recovery records the loss, it does not replay the work.
