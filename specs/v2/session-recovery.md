# V2 post-crash Session continuation recovery

Status: implemented core policy and HTTP controls. This document is the
contract for the durable provider-attempt boundary in
`packages/core/src/session/recovery/` and the recovery routes in the V2
Session API. It is intentionally conservative: a process-local wake is not
evidence that a provider call is safe to replay.

## Safety rule

A Session drain owns one provider turn at a time. Before dispatch it writes a
`session_provider_attempt` row in `prepared` state. It changes that row to
`dispatched` immediately before calling `llm.stream(request)`. The boundary
is deliberately after request assembly and before the external side effect:

```text
promote input -> project history -> assemble request
        |
        v
   prepared ------------------------------+
        |                                 |
        | mark dispatched                 | process loss before dispatch
        v                                 v
   dispatched                         retry_ready
        |                                 |
        +-- provider outcome             +-- one safe automatic retry
        |                                 |
   succeeded / failed                   old row abandoned(auto_retrying)
        |
   process loss after dispatch
        v
   abandoned(decision_required)
```

The `prepared` branch is the only branch eligible for an automatic retry. A
`dispatched` row means the provider may have received the request, even when
no assistant output or durable tool result exists. The system therefore never
re-dispatches it implicitly. A provider error that is durably observed is
`failed`; an interrupted or outcome-less dispatched turn is
`abandoned`/`decision_required` and remains visible for an explicit human or
client decision.

The row includes `runtime_id`, `fence`, `step`, `retry_count`, preparation and
dispatch timestamps, `heartbeat_at`, `lease_until`, `next_retry_at`, and an
optional error. `runtime_id` is only an audit marker. Writes require the row
identity, status, runtime marker, fence, and an unexpired attempt lease.
Heartbeats renew the lease while `llm.stream` is active. If a runtime loses
the lease, its settlement is rejected; a later runtime can fence the row
without accepting stale completion.

The Session execution lease applies the same rule to the whole drain: only a
runtime holding the `(session_id, runtime_id, fence)` lease can start a
provider turn. Its heartbeat is independent of the provider-attempt heartbeat.
A Session lease loss interrupts the local drain; it does not turn an unknown
provider outcome into a retryable result.

## Input and projected-history semantics

Recovery does not invent a new durable execution identity. The durable
`session_input` inbox and projected Session history remain the sources of
truth:

- admitted input is durable before execution; `steer` input is promoted at a
  safe provider-turn boundary and `queue` input is promoted FIFO when the
  current drain would otherwise become idle;
- a promoted input and its projected history are never silently rolled back by
  a crash;
- a provider attempt records the `step` that rendered its request, so a
  continuation can reload projected history and start a fresh turn rather
  than replaying a local in-memory request;
- local tool calls are durably projected before side effects and their
  settlement is awaited before continuation. A crashed `running` local tool
  is failed as interrupted before the next provider request; it is never
  silently executed twice;
- live background-job completion uses `steer` plus an advisory process-local
  wake. Recovery notes use `queue` and do not publish a wake. A wake only
  schedules a drain; it never authorizes provider replay.

## Startup discovery

`SessionRecovery` is a process-global root service. Its construction performs
one non-executing discovery pass before the root `SessionExecution` subscribes
to wakes. Discovery is compare-and-set and lease-aware:

1. old `prepared` rows with no recovery marker become `retry_ready`, receive a
   bounded backoff (`RETRY_BACKOFF_MS`), and have their fence incremented;
2. expired or lease-less old `dispatched` rows become
   `abandoned`/`decision_required`, receive the stable unknown-outcome error,
   have their lease cleared, and have their fence incremented;
3. a live heartbeat is not claimed, and a race with another owner loses the
   guarded update rather than overwriting it;
4. discovery only records state and emits an operational log. It does not
   call a provider, promote input, enqueue a wake, or create a model-visible
   message by itself.

This makes startup safe for clustered runtimes. A later Session activity can
observe the recovery row. A preparation-only row may be consumed for one
automatic retry once its backoff expires. An ambiguous dispatched row waits
for explicit retry or abandon; no advisory wake can bypass that decision.

## Retry and abandon policy

The retry budget is explicit and bounded:

| path      | allowed outcome                             |                     budget |                         delay | confirmation                                    |
| --------- | ------------------------------------------- | -------------------------: | ----------------------------: | ----------------------------------------------- |
| automatic | old row was `prepared`, never dispatched    |        one automatic retry |                      1 second | none                                            |
| explicit  | abandoned preparation or ambiguous dispatch | two explicit retries total | 1 second before the next turn | `confirmAmbiguous=true` for `decision_required` |

A retry does not re-use the old request or provider-local IDs. It resets the
same durable attempt row to `prepared`, assigns the current runtime marker,
increments the fence and retry count, and waits for normal Session activity
to assemble a fresh request. The old preparation-only row consumed by the
safe automatic path is retained as `abandoned`/`auto_retrying` for audit; the
next provider turn creates a new attempt with the carried retry count.

`abandon` is terminal for the current attempt. It records
`abandoned`/`abandoned`, a completion timestamp, an explicit error, and a new
fence. It does not dispatch, promote, or wake anything. A client may still
request an explicit retry later while the bounded explicit budget remains;
`confirmAmbiguous=true` is required whenever the current recovery marker is
`decision_required`. Budget exhaustion and races that lose the guarded update
are reported as non-retryable/no-op outcomes rather than starting a provider
call.

The policy does **not** claim provider idempotency. Even an explicit retry of
an ambiguous dispatch can duplicate an external request; confirmation is the
visible acknowledgement of that risk, not a guarantee. Tool calls are not
replayed from a stale provider attempt. Safe automatic retry is limited to the
pre-dispatch branch because no provider side effect could have begun at that
boundary.

## HTTP contract

All routes require the existing authenticated V2 Session API boundary and
first verify that the Session exists. The endpoints expose durable rows for
that Session only; the response uses snake_case wire names:

- `GET /api/session/:sessionID/recovery` returns `{ data: SessionRecoveryAttempt[] }`.
  Each row includes `id`, `session_id`, `runtime_id`, `fence`, `step`, `status`,
  optional `recovery`, `retry_count`, `prepared_at`, optional
  `dispatched_at`/`completed_at`/`next_retry_at`, and optional `error`.
- `POST /api/session/:sessionID/recovery/:attemptID/retry` accepts an optional
  `{ "confirmAmbiguous": true }` body and returns the updated durable row.
  Missing confirmation for `decision_required` is a 409
  `RecoveryConfirmationRequiredError`; an attempt in a non-retryable state or
  with an exhausted budget returns a typed 409; an unknown attempt is a 404
  `RecoveryAttemptNotFoundError`.
- `POST /api/session/:sessionID/recovery/:attemptID/abandon` records the
  explicit terminal decision and returns the updated row. It never wakes a
  Session or calls a provider.

The generated JavaScript SDK is regenerated from the checked-in V2 OpenAPI
contract after these route changes. `openapi.json`, package config, and lock
files are local generation artifacts and are not part of the feature commit.

## Verification obligations

The core recovery suite covers preparation versus dispatch ambiguity, fencing,
backoff and retry budget, plus expired Session lease acquisition. The HTTP
harness covers list, confirmed ambiguous retry, and abandon. Route coverage
must be run in both coverage and auth modes with fail-on-missing and
fail-on-skip. A full `packages/opencode` typecheck is intentionally not a
sandbox gate; run the scoped protocol, core, server, and SDK checks
sequentially because the full root check is OOM-prone in the development
sandbox.
