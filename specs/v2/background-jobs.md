# V2 Background Jobs over Tool Execution

Status: implemented (branch `arena/01a0b0bc-opencode`). Supersedes the
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

This slice implements gate 2 (model-facing launch + owner-bound observation +
inbox completion delivery). Gates 1 and 3 stay closed by design; see
"Remaining slices".

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
  observation is deliberately indistinguishable from absence.
- `job_get` returns the current status snapshot (`running | completed |
error | cancelled`) with output or error when settled.
- `job_wait` blocks up to `timeout` ms (default 30s, max 300s) for
  completion, returning `{ timedOut }` explicitly so the model can choose to
  keep polling, keep working, or cancel.
- `job_cancel` interrupts the job's scope. Cancellation is terminal and
  never generates an inbox note (the cancelling actor already knows).

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

## Semantics guarantees (and non-guarantees)

- Launch is synchronous within the settle: `BackgroundJob.start` publishes
  the job before forking, so a race where the job completes before the model
  learns its id cannot produce a lost note — the completion watcher runs
  after `start` returns.
- Turn interruption does not cancel background jobs: they live in the global
  process-local registry scope, not in the per-turn tool `FiberSet`. The
  explicit control surface is `job_cancel`. Process shutdown loses the jobs
  (registry is process-local) — gate 1 territory.
- The completion watcher lives in the Location scope of the tool layer, so
  it survives the settling fiber but dies with the process, matching the
  registry's lifetime.
- Job output preview in the note is best-effort: the full string output is
  retained by the registry for the process lifetime.

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
  - `job_get` returns owner-session jobs and hides other sessions' jobs as
    "Unknown job",
  - `job_wait` returns `timedOut: true` for unfinished jobs, resolves with
    output after completion,
  - `job_cancel` transitions the job to `cancelled` and releases waiters,
  - completion delivery appears as a pending queue-delivery session input
    via `SessionInput.find`, and cancelled jobs deliver nothing.

Core typecheck (`packages/core`, tsgo) must pass; the full
`packages/opencode` typecheck does not fit the ~3.9 GB sandbox (baseline
already takes ~700 s and is OOM-prone) and is intentionally not gating here.

## Remaining slices

- **Durable status / restart recovery (gate 1)** and remote/HTTP observation
  (gate 3): persist job records and define ownership fencing before any
  HTTP/SDK exposure; tracked with the interruption/retries/fencing entry in
  `todo.md`. Until then app-level observation (`@/background/job` instance
  registry, experimental handler) continues to see only V1 jobs — V2 core
  jobs are a separate process-local namespace by design.
- **Auto-resume on completion delivery**: wake `SessionExecution` for idle
  sessions (and steer into active ones) once the decision belongs to the
  continuation-recovery slice rather than the tool layer.
- **Background agent dispatch**: the `job_*` tools are agent-dispatch ready
  (ownership + wait/cancel are dispatch-agnostic), but a V2 sub-agent tool
  does not exist in core yet; port `task` from the app package first
  (listed in `tool/builtins.ts` TODO).
- Longer-running jobs beyond `MAX_TIMEOUT_MS` need a persistent-job concept
  that survives restart; deliberately out of scope until gate 1.
