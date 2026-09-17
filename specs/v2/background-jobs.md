# V2 Background Jobs over Tool Execution

Status: gates 1+2 implemented (gate 2 on branch `arena/01a0b0bc-opencode`,
gate 1 on branch `arena/01a0b171-opencode`). Supersedes the "integrate the
new BackgroundJob service with V2 tool execution" entry in `todo.md`. This
document is the design contract; keep the remaining-slices section accurate
as follow-ups land.

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
completion delivery). Gate 1 landed next and is specified below. Gate 3 stays
closed by design; see "Remaining slices".

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

When a background job finishes with `completed` or `error`, the launcher
admits a durable queue-delivery session input
(`SessionInput.admit`, the exact path user prompts use) containing a short
note: job id, command, status, exit/error line, and an output preview (last
~1.5 KB; full output via `job_get`). Being a real `PromptAdmitted` event,
the note is durably recorded and joins normal queued-input promotion: it
surfaces to the model on the session's **next run** (or the next queued
promotion of the current run).

Delivery does **not** auto-resume an idle session. Starting a provider turn
is `SessionExecution` territory, and depending on it from a tool would close
a layer cycle (runner → tool registry → bash → execution → runner). Deferred
to the continuation-recovery slice in `todo.md`, together with steer-vs-queue
promotion of completion notes (`active` set lookup).

Restart recovery delivers the same kind of note for jobs it claims as
`interrupted` (see below), so the session learns the job's fate on its next
activity even across a process crash.

## Durable status (gate 1)

### Persistence contract

Tool-launched jobs persist to the `background_job` table in the (global)
SQLite database:

| column | content |
| --- | --- |
| `id` | job id (primary key) |
| `type` | launcher type, e.g. `bash` |
| `title` | display title (command preview) |
| `session_id` | owning session (FK → `session`, cascade delete), indexed with `status` |
| `status` | `running`, `completed`, `error`, `cancelled`, or `interrupted` |
| `runtime_id` | per-process marker of the runtime that started the row |
| `started_at` / `completed_at` | epoch millis |
| `output` | bounded tail of the settled output (last 16 KB, `…`-prefixed when truncated) |
| `error` | settled error text, or the recovery message |
| `metadata` | the owner metadata JSON exactly as stored on the registry job |

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

### Runtime identity and restart recovery

Each process generates one ascending `runtime_…` identifier. Recovery runs
once per Location service boot inside the `tool/job` node (before any tool
can execute) and claims every row that satisfies **both**: `status =
running` **and** `runtime_id` differs from the current process. Each claim is
an atomic `UPDATE … WHERE id = ? AND status = 'running' RETURNING`, setting
`status = interrupted`, `completed_at = now`, and
`error = "Process exited while this job was running; its outcome is
unknown."` Rows belonging to the current runtime are never touched (this
also makes recovery idempotent across Location rebuilds within one process),
and settled rows are never reopened.

For each claimed row whose owning session still exists, recovery admits the
same durable queue-delivery completion note the live watcher would have
delivered (skipped for deleted sessions and rows without owner metadata;
claim and delivery are independent — a delivery failure never unclaims the
row).

### Semantics guarantees (and non-guarantees)

- Single-writer assumption: recovery is correct under **one live runtime per
  database**. Two processes against one SQLite database can race on claims;
  this is the same class as the existing process-local advisory-wake and
  migration-claiming debt in `todo.md`. Stale-owner fencing (leases,
  heartbeats, or clustered ownership) is a later slice and must not be
  inferred from `runtime_id` alone.
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
  - completion delivery appears as a pending queue-delivery session input
    via `SessionInput.find`, and cancelled jobs deliver nothing,
  - launch persists a `running` row and settlement persists status, bounded
    output tail, and completion time; cancellation persists `cancelled`,
  - recovery claims foreign-runtime `running` rows as `interrupted`, leaves
    current-runtime and settled rows untouched, delivers a queue note for
    existing owner sessions, skips deleted sessions, and the claimed job
    becomes observable through `job_get` with an empty registry.

Core typecheck (`packages/core`, tsgo) must pass; the full
`packages/opencode` typecheck does not fit the ~3.9 GB sandbox (baseline
already takes ~700 s and is OOM-prone) and is intentionally not gating here.

## Remaining slices

- **Remote/HTTP observation (gate 3)**: durable status and restart recovery
  now exist; what remains is defining authorization for job observation
  (whose jobs may an API consumer list/read?) and adding the routes/SDK
  surface, keeping owner-bound semantics for model-facing access. Until then
  app-level observation (`@/background/job` instance registry, experimental
  handler) continues to see only V1 jobs — V2 core jobs stay a separate
  namespace by design.
- **Auto-resume on completion delivery**: wake `SessionExecution` for idle
  sessions (and steer into active ones) once the decision belongs to the
  continuation-recovery slice rather than the tool layer.
- **Stale-owner fencing / clustered execution**: lease or heartbeat-based
  ownership so multiple runtimes can share one database safely; builds on
  the `runtime_id` column but must not be inferred from it yet. Tracked with
  the interruption/retries/fencing entry in `todo.md`.
- **Background agent dispatch**: the `job_*` tools are agent-dispatch ready
  (ownership + wait/cancel are dispatch-agnostic), but a V2 sub-agent tool
  does not exist in core yet; port `task` from the app package first
  (listed in `tool/builtins.ts` TODO).
- Longer-running jobs beyond `MAX_TIMEOUT_MS` need a persistent-job concept
  that survives restart *and* re-executes; deliberately out of scope —
  recovery records the loss, it does not replay the work.
