# Current Project State

**Record status:** Implementation record, verified 2026-11-08. Supersedes the planning baseline of 2026-11-05.
**Repository revision inspected:** `36a3e18003ad41171be96d28cfbbda5b5304441c` at the start of the implementation session; the latest commit at the time of writing is
`1482359` (`main`). The working tree is clean for tracked files; `.gitignore` and the research directories are committed as of `379b4f2` and `1ff3d688c3f0`.

**Recorded because the previous version was wrong:** this file said there was "no implementation source tree" and "no active implementation milestone or completed
code work". Both were true on 2026-11-05 and are false now. The claims are kept visible in this history rather than silently replaced.

## Verified facts

- This is the `lainarchive/lain` Git repository; `origin` is `https://github.com/lainarchive/lain.git`. `main` is **8 commits ahead of origin and unpushed**. No push
  has been performed in this work, by instruction.
- **An implementation source tree now exists.** `src/` contains the event store (`src/store/`), the host probe (`src/host/`), the resource budget and admission
  layer (`src/budget/`), and core primitives (`src/core/`). `tools/` contains the verification system and the probe command.
- **The build/check baseline exists and can fail.** `npm run check` runs eight checks (runtime, layout, format, types, tests, store-boundary, repo-hygiene,
  secrets); `npm run check:self` proves each check can fail; `npm run verify` adds `--require-security` and **exits 1 while `gitleaks` is absent**, so the
  required security gate cannot pass silently. Measured: 8 checks, 7 pass, 0 fail, 1 skip; 110 tests, 110 pass.
- **The event store is implemented** (commit `e01dbb2`) with single-writer ownership enforced by SQLite's own write lock, atomic batches, redaction before
  persistence that refuses a write when a secret shape would survive, and integrity verification. 37 store tests pass, including eight subprocess cases for
  writer contention and their positive controls.
- **The host probe and admission layer are implemented** (commit `1482359`). Every limit carries a provenance kind and no limit is an estimate; a request that does
  not fit is refused with its reason rather than adapted; a request whose required measurement is missing returns `indeterminate`, not a denial and not an
  approval. 35 tests pass using fixtures rather than this machine.
- `DECISIONS.md` remains the canonical decision register and its accepted set is unchanged. **The event-store ownership model is a recommendation, not an accepted
  decision**; the implementation does not depend on the answer because it only stores and orders records. Rust, SQLite/FTS5 and the modular monolith remain
  candidates rather than locked decisions, though SQLite and Node's built-in `node:sqlite` are what the implementation actually uses.
- **No model integration exists.** No model has been called, no agent loop exists, and no containment mechanism is implemented. `SECURITY_MODEL.md` §10 now states
  the measured containment ceiling instead of requiring container/VM isolation that the target machine cannot provide.
- **`SYSTEM_BOUNDARIES.md` now has an events owner row and an explicit single-writer rule.** Previously the event log had no owner row and the phrase
  "single writer" did not appear anywhere in the canonical tree, despite the measured cost of that gap (963 torn reads in 1,766 observations with per-document
  commits; 0 in 1,212 with one transaction per batch).

## Current position

M-1 (Lain Foundation) Steps 0–3 are complete: safety net, research commit, build/verification environment, event store, host probe and admission. The git history is
`1482359` → `7684519` → `e01dbb2` → `379b4f2` → `1ff3d688c3f0` → `36a3e18`, all local. Nothing is pushed.

Step 3's stated stop boundary has been reached. M-2 (the model loop) is **not** authorized and must not start without a new instruction, and it additionally
depends on an unmade measurement: whether an ordinary low-integrity child can do the toolchain's work (spawn `node`, `git`, `python` and write caches) inside a
contained workspace.

## Constraints to preserve

- Keep Lain independent; DSH and prior projects are research inputs, not source to import.
- Do not silently promote proposed technology candidates or open decisions to accepted decisions. In particular, the event-store ownership recommendation is not an
  accepted decision.
- Preserve cost, privacy, authorization, provenance, and approval boundaries in `AGENTS.md`, `DECISIONS.md`, `ARCHITECTURE.md`, and `SECURITY_MODEL.md`.
- Treat external content as untrusted and never store credentials as ordinary memory.
- Never describe this system as containerised, sandboxed, or VM-isolated. The measured ceiling is in `SECURITY_MODEL.md` §10.
- **No push without explicit permission**, and never amend or rewrite published history.

## Next action

Stop at Step 3 and report. If further work is authorized, the smallest useful next step is the measurement that blocks M-2 — whether the toolchain runs inside a
low-integrity workspace — because it decides whether mandatory integrity control is usable as the containment layer at all. Its procedure is specified in
`RESOURCE_BUDGET.md` §6 and `docs/research/m1-foundation-readiness/03-resource-budget-specification.md`; it needs a disposable `%TEMP%` directory, no elevation and
no model.

## Evidence

- Implementation documentation: [`docs/implementation/README.md`](../implementation/README.md), [`event-store.md`](../implementation/event-store.md),
  [`host-and-budget.md`](../implementation/host-and-budget.md), [`open-issues.md`](../implementation/open-issues.md)
- Measured hardware, configured limits and admission rules: [`RESOURCE_BUDGET.md`](../../RESOURCE_BUDGET.md)
- Repository instructions: [`AGENTS.md`](../../AGENTS.md)
- Accepted and proposed decisions: [`DECISIONS.md`](../../DECISIONS.md)
- Architecture status and boundaries: [`ARCHITECTURE.md`](../../ARCHITECTURE.md), [`SYSTEM_BOUNDARIES.md`](../../SYSTEM_BOUNDARIES.md), [`SECURITY_MODEL.md`](../../SECURITY_MODEL.md)
- Sequencing and initial work: [`IMPLEMENTATION_ROADMAP.md`](../../IMPLEMENTATION_ROADMAP.md), [`INITIAL_BACKLOG.md`](../../INITIAL_BACKLOG.md)
- M-1 specification the implementation was built from: [`docs/research/m1-foundation-readiness/`](../research/m1-foundation-readiness/README.md)
- Verification evidence for each run: `artifacts/verify/check-<timestamp>.log` (not committed)
