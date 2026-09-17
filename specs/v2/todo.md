# TODO

ok we need to work towards a launch of v2 so we can get out of this rebuild phase

## Post-Hono cleanup - Kit

The opencode server has moved to the Effect HttpApi backend. Remaining work is
mostly cleanup: delete compatibility shims, shrink Zod surfaces, and simplify
test harnesses that used to compare Hono and HttpApi behavior.

## New Data Mode - Dax

This is mostly done. I'm working through modeling subagents, skill invocations
and shell commands.

## Rework agent loop - Kit?

The first Effect-native local runner slice is implemented without bridging
through legacy `SessionPrompt.loop(...)`:

- process-global `SessionExecution.resume(sessionID)` discovers Location from
  the Session read model
- cached Location-scoped `SessionRunner` resolves one supported catalog model
  and issues one explicit `llm.stream(request)` provider turn at a time
- durable V2 projections record text, reasoning, provider failures, tool calls,
  tool results, and assistant output
- a scoped `ToolRegistry` advertises definitions and the first permission-checked
  `read` built-in
- local continuation reloads projected history, and promoting new user input resets the selected agent's configured provider-turn allowance
- concurrent resumes for one Session join one process-local run while different
  Sessions remain concurrent

Prompt admission now uses a durable `session_input` inbox rather than immediate
transcript projection. `steer` inputs promote at the next safe provider-turn
boundary while the current drain requires continuation. `queue` inputs remain in
a FIFO until the Session would otherwise become idle and then promote one at a time.

Next reviewed slices:

- preserve eager structured local-tool settlement: durably record each complete
  call, start its child execution immediately, await every settlement after the
  provider turn closes, then reload projected history once
- revisit per-turn tool-call limits, output truncation, and operational
  backpressure before broadening exposure; eager local execution is deliberately
  unbounded in the current local slice while SQLite publication stays serialized
- remove the public in-memory `@opencode-ai/llm` tool loop after replacing its
  remaining one-turn native-adapter use with a narrow typed dispatcher
- ~~batch streamed deltas and add covering context indexes~~ **done** (arena/01a0b0bc):
  live-only text/reasoning/tool-input deltas coalesce per fragment (50ms window, 16KB
  threshold, boundary/settlement/failure flushes); projected-history context indexes
  verified adequate (`event_aggregate_seq_idx`, `session_message_session_seq_idx`) — see
  `specs/v2/streaming-responsiveness.md`
- ~~expose replayable Session event cursors over HTTP and the generated SDK where remote consumers need them~~ **done** (arena/01a0b0bc):
  endpoints, handlers, generated SDK already existed; this slice added cursor-semantics
  route coverage (`v2.session.history.cursor`, `v2.session.events.cursor`) and the consumer
  contract docs — see `specs/v2/session-event-cursor.md`. Remaining adoption slice:
  wire app/desktop sync to resume from cursors (depends on New Data Mode)
- ~~integrate the new BackgroundJob service with V2 tool execution~~ **done** (arena/01a0b0bc):
  model-facing bash `background: true` launch through the process-local registry, owner-bound
  `job_get`/`job_wait`/`job_cancel` tools, and durable queue-delivery completion notes into the
  session inbox — see `specs/v2/background-jobs.md`
- ~~persist background job status and define restart recovery~~ **done** (arena/01a0b171):
  durable `background_job` table written around the process-local registry (best-effort: a
  persistence failure never blocks or hides a live job), per-process `runtime_id` marker, and
  boot-time recovery that atomically claims foreign-runtime `running` rows as `interrupted` and
  delivers the usual inbox completion note to existing owner sessions; `job_*` tools fall back
  to the durable row after registry loss and keep owner-bound hiding. Single-writer-per-database
  assumption documented; fencing stays deferred. See `specs/v2/background-jobs.md`. Remaining
  slices tracked there: stale-owner fencing, HTTP mutation (needs fencing), and background
  agent dispatch (needs a V2 task tool port)
- ~~expose HTTP background-job observation~~ **done** (arena/01a0b189): read-only
  `GET /api/job` (+ `?sessionID`/`?status`/`?limit`) and `GET /api/job/:jobID` on the V2
  protocol surface, backed by the durable rows (newest-first; the registry is deliberately
  not consulted). Authorization decided explicitly: instance-wide, following the V1
  experimental precedent — owner-bound hiding stays model-facing-only. Output is the
  persisted 16 KB tail; contract and consequences in `specs/v2/background-jobs.md`
- ~~auto-resume idle Sessions when background-job completion notes land~~ **done** (arena/01a0b19d):
  live settlement delivery admits the note as a `steer` (an active drain promotes it at the next
  provider-turn boundary instead of waiting to go idle) and publishes a process-local advisory wake
  over a shared `SessionWake` hub that the root execution layer subscribes to, so an idle Session
  resumes without the tool layer depending on `SessionExecution`. Restart recovery stays
  `queue`-delivery and silent: a just-booted process does not schedule provider work. The wake is
  advisory only — it never re-dispatches an interrupted provider attempt. See
  `specs/v2/background-jobs.md`
- add durable/clustered interruption, retries, and stale-owner fencing only as
  their slices become concrete

### Deferred durable continuation recovery

Do not infer that ambiguous provider work is safe to retry from an advisory wake.
Inbox-driven resume is landed for background-job completion (see the entry above),
but it only drains durable input; it never re-dispatches a provider attempt.
The first inbox-driven runner intentionally omits outer provider-attempt markers
until they have a concrete consumer and a complete recovery policy.

Design post-crash continuation recovery as one explicit slice. It should model:

- promoted input and projected-history state
- queued-input promotion and steering assignment
- provider-attempt preparation versus provider-dispatch ambiguity
- required post-tool continuation across process loss
- explicit `retry` and `abandon` decisions for unknown outcomes
- bounded automatic retry only where provider and tool idempotency make it safe
- retry budget, backoff, visible recovery status, startup discovery, and future
  clustered ownership fencing

Do not introduce an enclosing durable execution identity solely to group these
facts; a process-local Session drain has no durable transcript boundary.

## Plugin API design - James?

We need to figure out how we want server plugins to work and what hooks are useful.

Some ideas:

- plugins get immer drafts so bad mutations can be thrown away
- plugins get global "opencode" instance like in that post i showed
- opencode instance has stuff like `opencode.session.prompt()` or
  `opencode.tool.register({...})`

## Rework Config - ???

We should do another pass on config to clean up any mistakes we made with it and
simplify as much as possible. Old configs should get auto-converted to new

## Auth - ???

I have a basic auth system that can track any kind of auth, not just providers

## Model Database - ???

I have a basic model service that allows for models to be registered dynamically

## Provider - ???

Providers should register as plugins and autoload based on whatever logic they
want / config. They should register models into model database

## Event - Kit

The self-contained durable `EventV2` core service is implemented. It owns
sync-versioned persistence, transactional sequencing, pub/sub, replay, and
replay-owner claims without relying on the old bus system.

Remaining slices:

- ~~expose the embedded consumer-facing Session cursor API over HTTP and the
  generated SDK where remote consumers need it~~ **done** (arena/01a0b0bc): verified
  end-to-end with new cursor-semantics route coverage; consumer contract documented in
  `specs/v2/session-event-cursor.md`
- keep replay-owner claims distinct from future clustered Session execution
  ownership and stale-runtime fencing

## Deferred hardening cleanup

Keep these visible, but do not block functionality slices on them unless a concrete
failure appears during canary work:

- serialize database migration claiming across processes; current migration
  application is protected only by an in-process semaphore, so two processes
  starting against one SQLite database can still race (same class:
  background-job restart-recovery claims assume one live runtime per
  database; `runtime_id` is a marker, not a fence)
- simplify process-local durable-tail wake lifecycle with Effect `RcMap` and one
  shared `PubSub.sliding<void>(1)` per active aggregate; keep SQLite cursor replay
  and subscribe-before-history semantics unchanged
- page large durable aggregate replay reads instead of loading every row after a
  stale cursor into one array
- decide whether connected tails need a periodic polling fallback for
  cross-process SQLite writers; current advisory wakes are intentionally
  process-local
- stream-cap websearch body collection before parsing
- add ripgrep execution timeout and bounded line framing
- materialize or consistently reject unresolved URL and file attachment sources
- decide stateless OpenAI Responses hosted-tool continuation behavior; reconstructed hosted output can replay as a stored `item_reference` when `store !== false`, while `store: false` intentionally omits the unavailable reference path
- decide whether to preserve deprecated `@opencode-ai/llm` orchestration exports
- preserve or alias renamed filesystem SDK generated type names if compatibility
  consumers require them
- revisit syscall-level mutation confinement for hostile external processes
  (`openat`, `O_NOFOLLOW`, and descriptor-relative mutation where supported)

## Everything is hotreloadable - ???

Instead of needing to tear down things when something changes every service should emit granular events so services can react to them and reconfigure themselves. Allows frontend to receive these too, eg model.added. also prevents startup from blocking
