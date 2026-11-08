# Current Project State

**Record status:** Implementation record, verified 2026-11-08. Supersedes the planning baseline of 2026-11-05.
**Repository revision inspected:** `d12fda0086b88ed3f6ee12cc9caee1e93c7f38d5` at the start of the V-1 session; V-1 itself is
`2b90c9b5416a77992fa8f62a8be0c04f7a86fe90` (`feat: run one authorized task end to end without a model`), followed by
`9fda0a2` (`docs: record the V-1 implementation state`) and `2cf60c9` (`style: drop the trailing blank line the format gate refuses`), which is the commit
this record describes. The working tree is clean.

**Recorded because the previous version was wrong:** this file said there was "no implementation source tree" and "no active implementation milestone or completed
code work". Both were true on 2026-11-05 and are false now. The claims are kept visible in this history rather than silently replaced.

## Verified facts

- This is the `lainarchive/lain` Git repository; `origin` is `https://github.com/lainarchive/lain.git`. `main` is **18 commits ahead of origin and unpushed**, and
  `git ls-remote origin refs/heads/main` still reports `7074c0db…`. No push has been performed, by instruction.
- **`gitleaks` is installed** (8.30.1, `Gitleaks.Gitleaks` via `winget`; D-P9 approved 2026-11-08). The required security gate therefore produces a real verdict:
  `npm run verify` **exits 0 with `checks=8 pass=8 fail=0`**, and the advisory skip that appeared in every earlier report is gone. Its first scan found two
  historical findings — both the synthetic JWT fixture on `test/store/redaction.test.mjs:70` in commit `e01dbb2`, no real credential. The fixture's base64
  obfuscation did not hide it, because gitleaks' `jwt-base64` rule decodes base64 before matching; the fixture is now assembled from its segments at runtime, and
  `.gitleaksignore` carries exactly two fingerprints for the historical blob. A clean scan means no known pattern matched, not that the repository is proven clean.
- **An implementation source tree exists.** `src/` contains the event store (`src/store/`), the host probe (`src/host/`), the resource budget and admission layer
  (`src/budget/`), core primitives (`src/core/`), the Policy Engine (`src/policy/`), task records (`src/tasks/`), the contained workspace (`src/exec/`), the tool
  registry and invocation path (`src/tools/`), the task runner (`src/agent/`) and the CLI (`src/cli/`). `tools/` holds the verification system, the probe command
  and the boundary checks.
- **The build/check baseline exists and can fail.** `npm run check` runs eight checks (runtime, layout, format, types, tests, store-boundary, process-boundary,
  repo-hygiene) plus the secret scan; `npm run check:self` proves each check can fail; `npm run verify` makes the secret scan required and now **passes**, because
  gitleaks is installed.
- **Measured at `0c5dca8`:** 153 tests, 153 pass, 0 fail; `npm run verify` → **`checks=8 pass=8 fail=0`, exit 0**; `node tools/verify.mjs --self-test` → 8 of 8;
  `tsc --noEmit` → 0 errors; `npm run check:format-strict` → `owned_violations: 0`, `legacy_violations_not_enforced: 874`; `gitleaks detect` → `no leaks found`,
  24 commits scanned.
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
  likewise a set of recommendations: the user approved **V-1** and then **D-P9**, so **D-P9 is answered and closed** while **D-P1 (push) remains unanswered and
  unacted on**.

## Current position

**M-1 (Lain Foundation) is complete and V-1 (One Authorized Task) is implemented and committed.** The local history is
`0c5dca8` → `55c27c1` → `2cf60c9` → `9fda0a2` → `2b90c9b` → `d12fda0` → `d5452f1` → `38a5e66` → `affdc67` → `1482359` → `7684519` → `e01dbb2` → `379b4f2` →
`1ff3d688c3f0` → `36a3e18` → `01ac126`, all local, nothing pushed.

**Every gate is green for the first time.** `npm run verify` passes with the secret scan required; there is no advisory skip left in any check.

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

1. **D-P1 — off-device protection.** 18 commits exist in exactly one place, on one disk. Pushing them to `origin` is the only genuinely off-machine copy
   available without removable media, and it needs explicit permission.
2. **The M-2 authorization question**: whether to build the model loop, which additionally needs the model-binding spike (the ollama daemon is not listening and
   no model is pulled, so it cannot be tested today).
3. **The remaining V-1 gaps**, in the order they matter: reads are unrestricted, the network is unrestricted, no Job Object limits, no cancellation, and the
   approval ledger has no prompt wired to it. Issues 10–12 in [`open-issues.md`](../implementation/open-issues.md).

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
