# V2 test-suite performance contract

Status: active. This is the normative contract for test-speed work. The
historical benchmark and hypothesis log lives in `perf/test-suite.md`; keep
measurements there and keep this document stable enough for CI and local
contributors to follow.

## Goals and non-goals

Test-speed work may reduce setup, waiting, process churn, or redundant fixture
construction. It must not reduce assertions, route coverage, failure
visibility, or the isolation guarantees that make a test meaningful. A change
that only makes a single noisy run faster is not a win until the focused test
still passes repeatedly and the broader suite remains green.

This contract does not require parallelizing all tests. The repository is
worked on in constrained environments, and subprocess-heavy integration tests
can be slower or less reliable when they contend for CPU, ports, SQLite
files, or memory.

## Required commands

From `packages/opencode`:

```sh
# Full-suite sanity benchmark. One measured run is the default.
bun run bench:test

# Repeat only when measuring a targeted hypothesis.
BENCH_WARMUPS=1 BENCH_RUNS=3 bun run bench:test

# Sequential per-file discovery, optionally narrowed while exploring.
bun run profile:test
TEST_PROFILE_GLOB='test/server/**/*.test.ts' TEST_PROFILE_TOP=15 bun run profile:test
```

The benchmark runs the same `bun test --timeout 30000` suite that contributors
would run; it does not use `--only-failures`, skip files, or swallow output.
The per-file profiler starts one child process at a time so its timings are
comparable and it cannot create a memory storm. A profiler failure prints the
captured output and exits non-zero.

HTTP API route changes additionally require the harness from `packages/opencode`:

```sh
bun run script/httpapi-exercise.ts --mode coverage --fail-on-missing --fail-on-skip
bun run script/httpapi-exercise.ts --mode auth --fail-on-missing --fail-on-skip
```

The `effect` mode is an opt-in provider/model integration surface. If it is
run, record external dependency failures separately; coverage and auth modes
are the route-contract gates.

## Metrics and evidence

A benchmark report must include:

- `METRIC test_suite_seconds`: median measured wall-clock duration;
- `METRIC test_suite_best_seconds` and `test_suite_worst_seconds`;
- the run count, warmups, commit/tree state, and any failures;
- for profiling, `METRIC slowest_test_file_seconds`, the profiled file count,
  and the slowest-file table;
- the exact focused command and at least three sequential after-runs for a
  claimed speedup, unless the change is an obviously mechanical setup removal
  and the report says that timing is neutral.

Use medians, not the best run, to decide. Retain noisy or failed runs in the
log. Never benchmark two heavy commands concurrently in the sandbox: the
current development environment is about 3.9 GB RAM with no swap, and the
full `packages/opencode` typecheck is explicitly not a test-speed gate.

## Hypothesis loop

Every optimization follows this sequence:

1. identify a measured bottleneck with the profiler or a focused benchmark;
2. write a falsifiable hypothesis in `perf/test-suite.md`;
3. make the smallest behavior-preserving change;
4. run the focused test repeatedly, then the relevant scoped typecheck;
5. compare sequential medians and inspect coverage/assertion output;
6. keep only a stable or clearly simplifying win, and record neutral or
   discarded experiments instead of deleting their evidence;
7. run a full-suite sanity benchmark before the final review.

A change is rejected when it relies on fixed sleeps being shortened without a
readiness signal, removes repository state that the assertion actually needs,
weakens timeout/error assertions, changes fixture isolation, or makes tests
pass only under a particular execution order.

## Fixture and concurrency rules

- Prefer the lightest fixture that proves the behavior: no Git repository for
  filesystem/config tests that do not inspect Git; no LLM server for tests
  that never call a model; no listener or subprocess when an in-process
  collaborator gives the same assertion.
- Keep Git, listener, provider, and subprocess setup explicit when the test
  asserts that behavior. Do not hide it in a faster shared global fixture.
- Replace fixed waits only with a deterministic readiness condition or an
  explicit test-only timeout parameter whose production default is unchanged.
- Keep database and temporary-home isolation per test where writes can race.
  Parallelize only independent subprocess cases with isolated ports and
  directories; do not add global concurrency to the suite.
- A speed change that affects model-facing or durable behavior needs the
  owning V2 contract updated, not merely a faster test.

## Coverage and typecheck gates

Test-speed work is subordinate to correctness. Before merging a slice:

- the focused tests pass with normal failure reporting;
- affected package typechecks pass sequentially (`protocol`, `core`,
  `server`, and SDK as applicable);
- HTTP route coverage has zero missing/skipped routes in the required modes;
- the full-suite sanity benchmark passes when the environment can afford it;
- generated OpenAPI, package config, and lock artifacts are not committed
  unless a separate repository rule explicitly requires them.

The canonical scripts are `packages/opencode/script/bench-test-suite.ts` and
`packages/opencode/script/profile-test-files.ts`. They intentionally do not
implement changed-file selection: a narrow run is useful during discovery but
cannot replace the full-suite gate.
