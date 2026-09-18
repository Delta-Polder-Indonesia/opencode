# Core Test Suite Speed — benchmark log

Measured baselines for the **`packages/core`** test suite.

`perf/test-suite.md` is the benchmark log for the `packages/opencode` suite
(its "Files In Scope" is `packages/opencode/test/**`). This file exists because
the core suite was optimized separately and its numbers were previously only
recorded in a commit message and in the session handover note, which made them
impossible to audit from the tree. Keep core-suite measurements here.

## Goal

Keep the `packages/core` test suite fast enough to run on every change without
reducing coverage or hiding failures.

## Benchmark Command

Run from `packages/core`:

```sh
bun test
```

Use plain `bun test`, **not** `bun run test`. The package script is
`bun test --only-failures`, which skips passing tests on a repeat run and so
does not measure the suite.

Core has no `bench:test` / `profile:test` script; time the plain run directly:

```sh
time bun test
```

## Primary Metric

`METRIC core_test_suite_seconds=<wall clock seconds>`

## Secondary Metrics

Test count, `expect()` call count, file count, and failures.

## Environment

Sandbox constraints materially affect these numbers; always record them.

| | |
| --- | --- |
| CPU | 2 cores, Intel(R) Xeon(R) @ 2.60GHz |
| RAM | 3939 MB total, no swap |
| bun | 1.4.2 |
| node | v22.22.3 |

Do not run two heavy processes at once in this sandbox. Concurrent `tsgo` or
test runs make the machine nearly unusable for ~10 minutes.

## Measurement Log

| Date | HEAD | Wall clock | Tests | Result | Provenance |
| --- | --- | --- | --- | --- | --- |
| 2026-09-18 | `5ee4b25f3` (parent, pre-optimization) | `38.8s` | 1140 | 1140/1140 pass | Reported in the body of commit `5ee4b25f3`. **Not re-measured** — recovering it requires checking out the parent commit and re-running. |
| 2026-09-18 | `5ee4b25f3` | `~26.5s` | 1140 | 1140/1140 pass | Reported by the optimizing session; see the same commit message (`~39s` to `~27s`). |
| 2026-09-18 | `9c3ad825c` | `26.95s`, `26.44s` | 1148 | 1148 pass, 0 fail, 3181 `expect()`, 149 files | **Re-measured this session**, two runs, `bun test` from `packages/core`. |

The current verified figure is the `9c3ad825c` row; treat `~26.5s` as the
working number, since the two runs spread over ~0.5s. The 8 extra tests versus
the 1140 baseline were added after the optimization landed, so the two runs are
not strictly comparable; the delta is small enough that the optimization still
holds (38.8s -> ~27s is ~30%).

Scoped typecheck for reference: `bun run typecheck` in `packages/core`
(`tsgo --noEmit`) completed in ~12s and exits 0 on `9c3ad825c`.

## What The Optimization Changed

Recorded from commit `5ee4b25f3` (`test(core): cut core test suite wall clock
from ~39s to ~27s`). No runtime code changed — fixtures, contention tests, and
a script only:

- `test/fixture/effect-flock-worker.ts` — compile `EffectFlock.node` via
  `LayerNode.compile` instead of `AppNodeBuilder.build`, which pulled in the
  whole location-services graph. Worker boot drops ~570ms -> ~270ms.
- `test/util/flock.test.ts`, `test/util/effect-flock.test.ts` — 8 workers
  instead of 16; pass tight `baseDelayMs`/`maxDelayMs` and smaller `staleMs`
  where the test asserts recovery rather than retry pacing.
- `script/migration.ts --check` — run the incremental diff and the full schema
  dump drizzle-kit invocations concurrently (independent outputs).

Profiling at the time attributed ~22s of the 38.8s run to ~15 tests, dominated
by subprocess boot in the flock contention tests (16 bun workers x ~570ms on
2 cores).

## Constraints

- The 2-core sandbox is the bottleneck for the flock contention tests. Do not
  raise the worker count back above 8 without re-profiling; that was the
  original cost driver.
- Full-repo `bun run typecheck` from the root OOM-kills in this sandbox
  (~3.9GB RAM, no swap). Quality evidence is the scoped typechecks
  (`packages/core`, `packages/protocol`, `packages/server`,
  `packages/sdk/js`) plus the test suite.
