# Current Project State

**Record status:** Implementation record, verified 2026-11-08. Supersedes the planning baseline of 2026-11-05.
**Repository revision inspected:** `d12fda0086b88ed3f6ee12cc9caee1e93c7f38d5` at the start of the V-1 session; V-1 itself is
`2b90c9b5416a77992fa8f62a8be0c04f7a86fe90` (`feat: run one authorized task end to end without a model`), followed by
`9fda0a2` (`docs: record the V-1 implementation state`) and `2cf60c9` (`style: drop the trailing blank line the format gate refuses`), which is the commit
this record describes. The working tree is clean.

**Recorded because the previous version was wrong:** this file said there was "no implementation source tree" and "no active implementation milestone or completed
code work". Both were true on 2026-11-05 and are false now. The claims are kept visible in this history rather than silently replaced.

## Verified facts

- This is the `lainarchive/lain` Git repository; `origin` is `https://github.com/lainarchive/lain.git`. `main` is **15 commits ahead of origin and unpushed**, and
  `git ls-remote origin refs/heads/main` still reports `7074c0db…`. No push has been performed, by instruction.
- **An implementation source tree exists.** `src/` contains the event store (`src/store/`), the host probe (`src/host/`), the resource budget and admission layer
  (`src/budget/`), core primitives (`src/core/`), the Policy Engine (`src/policy/`), task records (`src/tasks/`), the contained workspace (`src/exec/`), the tool
  registry and invocation path (`src/tools/`), the task runner (`src/agent/`) and the CLI (`src/cli/`). `tools/` holds the verification system, the probe command
  and the boundary checks.
- **The build/check baseline exists and can fail.** `npm run check` runs eight checks (runtime, layout, format, types, tests, store-boundary, process-boundary,
  repo-hygiene) plus an advisory secrets scan; `npm run check:self` proves each check can fail; `npm run verify` makes the secret scan required and **exits 1 while
  `gitleaks` is absent**, so the required security gate cannot pass silently.
- **Measured at `2cf60c9`:** 153 tests, 153 pass, 0 fail; `node tools/verify.mjs` → `checks=8 pass=7 fail=0 skipped_or_untestable=1` (the skip is the advisory
  secrets check, `files_considered: 124`, `fallback_hits: 0`, "this is NOT a clean scan"); `--self-test` → 8 of 8; `tsc --noEmit` → 0 errors;
  `npm run check:format-strict` → `owned_violations: 0`, `legacy_violations_not_enforced: 875`; `npm run verify` → exit 1.
- **One authorized task now runs end to end without a model.** `lain task run --task examples/hello-task.json` admits a task through the Policy Engine
  (`allow_with_conditions`, arm A8, condition `workspace_only`), runs `run_script` once inside `<LAIN_HOME>/workspaces/<task_id>`, evaluates both acceptance
  criteria, records the run, and reaches `completed` with evidence. `lain task show <id>` and `lain store verify` prove it from the records afterwards.
- **The Policy Engine is default-deny and total.** Ten arms with an explicit evaluation order; a refusal carries a machine-readable reason code; only a human's
  `deny` is retryable, and an indeterminate outcome never is.
- **The event store is implemented** (commit `e01dbb2`) with single-writer ownership enforced by SQLite's own write lock, atomic batches, redaction before
  persistence that refuses a write when a secret shape would survive, and integrity verification. The guarantee is **one write transaction at a time**, not
  continuous process ownership; a writer that loses the lock ends `STORE_LOCK_LOST` and stops.
- **No model integration exists.** No model has been called, no agent loop exists, and no containment mechanism beyond the workspace, the constructed environment
  and the path scrub is implemented. `SECURITY_MODEL.md` §10 states the measured containment ceiling rather than requiring container/VM isolation.
- `DECISIONS.md` remains the canonical decision register and its accepted set is unchanged. **The event-store ownership model is a recommendation, not an accepted
  decision**; the implementation does not depend on the answer because it only stores and orders records. The M-2 preflight's decision register (D-P1…D-P10) is
  likewise a set of recommendations: the user approved **V-1 only**, so D-P1 (push) and D-P9 (install gitleaks) remain unanswered and unacted on.

## Current position

**M-1 (Lain Foundation) is complete and V-1 (One Authorized Task) is implemented and committed.** The local history is
`2b90c9b` → `d12fda0` → `d5452f1` → `38a5e66` → `affdc67` → `1482359` → `7684519` → `e01dbb2` → `379b4f2` → `1ff3d688c3f0` → `36a3e18` → `01ac126`, all local,
nothing pushed.

## Constraints to preserve

- Keep Lain independent; DSH and prior projects are research inputs, not source to import.
- Do not silently promote proposed technology candidates or open decisions to accepted decisions. The event-store ownership recommendation, the M-2 decision
  register and the Tier 1 containment choice are recommendations until the user accepts them.
- Preserve cost, privacy, authorization, provenance, and approval boundaries in `AGENTS.md`, `DECISIONS.md`, `ARCHITECTURE.md`, and `SECURITY_MODEL.md`.
- Treat external content as untrusted and never store credentials as ordinary memory.
- Never describe this system as containerised, sandboxed, or VM-isolated. The measured ceiling is in `SECURITY_MODEL.md` §10, and the permitted sentence ends
  "Lain is not a sandbox."
- **No push without explicit permission**, and never amend or rewrite published history.

## Next action

V-1 is complete and its evidence is recorded; the next work needs a decision rather than a keystroke. The open items, in the order they block things:

1. **D-P1 — off-device protection.** 13 commits exist in exactly one place. Pushing them to `origin` is the only genuinely off-machine copy available without
   removable media, and it needs explicit permission.
2. **D-P9 — install gitleaks**, without which `npm run verify` cannot pass and the secret-scan gate stays advisory.
3. **The M-2 authorization question**: whether to build the model loop, which additionally needs the model-binding spike (the ollama daemon is not listening and
   no model is pulled, so it cannot be tested today).

## Evidence

- Implementation documentation: [`docs/implementation/README.md`](../implementation/README.md), [`event-store.md`](../implementation/event-store.md),
  [`host-and-budget.md`](../implementation/host-and-budget.md), [`task-execution.md`](../implementation/task-execution.md),
  [`open-issues.md`](../implementation/open-issues.md)
- Measured hardware, configured limits and admission rules: [`RESOURCE_BUDGET.md`](../../RESOURCE_BUDGET.md)
- Repository instructions: [`AGENTS.md`](../../AGENTS.md)
- Accepted and proposed decisions: [`DECISIONS.md`](../../DECISIONS.md)
- Architecture status and boundaries: [`ARCHITECTURE.md`](../../ARCHITECTURE.md), [`SYSTEM_BOUNDARIES.md`](../../SYSTEM_BOUNDARIES.md), [`SECURITY_MODEL.md`](../../SECURITY_MODEL.md)
- Sequencing and initial work: [`IMPLEMENTATION_ROADMAP.md`](../../IMPLEMENTATION_ROADMAP.md), [`INITIAL_BACKLOG.md`](../../INITIAL_BACKLOG.md)
- The M-2 preflight and its decision register: [`docs/research/m2-preflight/`](../research/m2-preflight/README.md)
- Verification evidence for each run: `artifacts/verify/check-<timestamp>.log` (not committed)
