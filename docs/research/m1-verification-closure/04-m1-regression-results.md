# 04 — M-1 Regression Results

**Status:** Green, reproduced independently with the repository's own scripts.
**Date:** 2026-11-08
**Scope:** run the complete M-1 verification suite against the canonical checkout and record exact commands, counts and exit codes.
**Independent?** Yes — the commands were chosen from `package.json`, not from the previous report, and every exit code below is the shell's, not a summary of the output.

## Results

| # | Command (as defined in `package.json`) | Result | Exit |
|---|---|---|---|
| 1 | `npm test` → `node --test --test-reporter=spec "test/**/*.test.mjs"` | `tests 110 / suites 0 / pass 110 / fail 0 / cancelled 0 / skipped 0 / todo 0` | **0** |
| 2 | `npm run check` → `node tools/verify.mjs` | `SUMMARY checks=8 pass=7 fail=0 skipped_or_untestable=1` | **0** |
| 3 | `npm run check:self` → `node tools/verify.mjs --self-test` | `SUMMARY checks=8 pass=8 fail=0 skipped_or_untestable=0` | **0** |
| 4 | `npm run verify` → `node tools/verify.mjs --require-security` | `SUMMARY checks=8 pass=7 fail=1`; `[FAIL] secrets` | **1** |
| 5 | `npm run check:store-boundary` | boundary holds (vacuously: `src/store/` contains no policy identifier) | **0** |
| 6 | `npm run check:repo` | repository hygiene satisfied | **0** |

Per-check detail for run 2: `runtime`, `layout`, `format`, `types`, `tests`, `store-boundary`, `repo-hygiene` all `[PASS]`; `secrets` `[SKIP]` (advisory). For run 3, every check reports its self-test proof — for example `6/6 violations detected, src file not flagged` (layout), `7 violations detected, clean input produced none` (format), `a deliberate type error was detected` (types), `a deliberately failing test produced a non-zero exit and a fail count` (tests), `real check detected, comment-only mention ignored` (store-boundary), `5 rule checks detected their violation` (repo-hygiene), `6 secret shapes detected` (secrets).

## Classification, as the assignment requires

| Category | Content |
|---|---|
| **Passed** | 110 tests; 7 of 8 checks in normal mode; 8 of 8 self-test proofs; store-boundary; repo-hygiene |
| **Failed** | none, except the required security gate (see below) |
| **Skipped** | `secrets` in advisory mode only, with an explicit "this is NOT a clean scan" note |
| **Not testable** | full-history secret scanning — `gitleaks` is absent and was deliberately not installed |
| **Advisory** | `npm run check`'s treatment of `secrets` |
| **Required security gate** | `npm run verify` → exit 1, by design, while the scanner is missing |

**The one non-zero exit is correct behaviour, not a regression.** The gate is supposed to fail when it cannot scan; a green `npm run verify` on a machine without gitleaks would be the defect.

## What the regression does and does not establish

**Establishes:** the eight checks run and can fail (proved by self-test); 110 tests pass; type checking passes under `strict`; the store's own suite — including eight single-writer subprocess tests with their positive controls — passes; repository hygiene (dependency policy, pins, no forbidden staged paths) holds.

**Does not establish:** that the checks would catch a defect they do not model; that the tests cover untested paths (they do not cover model integration, containment, cancellation, or any M-2 surface); that the format gate covers the canonical documents (it explicitly does not — they are reported, not enforced); or that the suite is a security certification of any kind.

## Re-run after the corrections made during this assignment

The ownership-scope corrections touched `SYSTEM_BOUNDARIES.md`, `docs/implementation/event-store.md` and a comment in `src/store/index.mjs`. The full regression was re-run afterwards: `npm test` 110/110 (exit 0) and `npm run check` 7 pass / 0 fail / 1 skip (exit 0). No test needed changing.

## Limitations

- Timings were not compared against the previous run, so this is not a performance measurement.
- The suite runs on one machine, on one Node version (`24.21.0`), against one filesystem. The `runtime` check enforces the pin, but no second environment was exercised.
