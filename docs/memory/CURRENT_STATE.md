# Current Project State

**Record status:** Implementation record, verified 2026-11-08. Supersedes the planning baseline of 2026-11-05.
**Repository revision inspected:** `d12fda0086b88ed3f6ee12cc9caee1e93c7f38d5` at the start of the V-1 session; V-1 itself is
`2b90c9b5416a77992fa8f62a8be0c04f7a86fe90` (`feat: run one authorized task end to end without a model`), followed by
`9fda0a2` (`docs: record the V-1 implementation state`) and `2cf60c9` (`style: drop the trailing blank line the format gate refuses`), which is the commit
this record describes. The working tree is clean.

**Recorded because the previous version was wrong:** this file said there was "no implementation source tree" and "no active implementation milestone or completed
code work". Both were true on 2026-11-05 and are false now. The claims are kept visible in this history rather than silently replaced.

## Verified facts

- This is the `lainarchive/lain` Git repository; `origin` is `https://github.com/lainarchive/lain.git`. `main` is **in sync with `origin/main`**: the owner
  approved the push on 2026-11-08 and 18 commits were published fast-forward (`7074c0d..7f41c82`), verified afterwards by a live `git ls-remote` reading
  `7f41c829d699b83475b69294c6830466b182ffb1` for both `HEAD` and `refs/heads/main`. Nothing was forced, rewritten or tagged, and `7074c0d` is still an ancestor of
  the new tip, so the previously published history is intact. This closed **D-P1**: an off-machine copy of the work now exists.
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
  likewise a set of recommendations: the user approved **V-1**, then **D-P9** (install gitleaks) and **D-P1** (publish to `origin`), so those two are **answered
  and closed**. The rest of the register is still open.

## Current position

**M-1, V-1 (One Authorized Task), V-2 (Contained Execution) and V-3 (Read Isolation) are implemented and committed.** The local history ends
`ec166c7` → `0e0e69e`, and `main` is **19 commits ahead of `origin/main`**; the published tip is still `c204604a91d51b2d4b792f3be25cca19efeaeb1f`, so nothing
from V-2 or V-3 is off-machine. The working tree is clean at `0e0e69ede3f2cfe6f9b7e8270e5689ce399335cd`.

**V-2 closed the three V-1 gaps it was written for, and the milestone test passes for real.** `lain task run --cancel-after 200` against a 3-second blocking
script is stopped in **591 ms** and settles `cancelled`; before the tool runner went asynchronous the same command ran **3996 ms and completed**. Resource ceilings are
enforced by a job object through `tools/win32/job_host.py`, and the approval surface has a real prompt, `lain approve`, with the answer bound to the request digest.

**V-3 confines reads with an operating-system boundary, and the run path now actually uses it.** The tool is launched into a Windows **AppContainer** whose SID is
derived from the profile name `lain.tool.runner`; `LAIN_READ_POSTURE=kernel` selects it, and the CLI **refuses to run at all** when no posture is stated. Measured
through the shipped CLI on a file planted outside the workspace and on the user's `.ssh`: both `EPERM` (errno `-4048`), while a world-readable system file still reads
and the tool's own workspace write succeeds. The network is confined too, as a side effect rather than a goal: `EACCES` in **0 ms** for a public address, loopback
timed out where an unconfined control reached it in 3 ms, DNS `ENOTFOUND`. Eleven filesystem shapes are refused — traversal, absolute paths, hard links, junctions,
symlinks, ADS, case variants, an environment escape, a write outside. The hard-link row was reported wrong for a day and the correction is a **defect, not a clearance**: the
matrix compared `icacls` on `hard.txt` with `icacls` on `plain.txt`, which are different files (`mklink /H ws\hard.txt secret\secret.txt` makes `hard.txt` a second name for
the file *outside* the workspace), so the comparison proved nothing. A link and its target genuinely are one file with one security descriptor — proven by mutation, not by
comparing two renderings — and that is exactly why a link planted in the workspace before the grant is enough for the grant to write the container's own inheritable ACE onto
the object the link names, in a directory protected from inheritance and never granted, after which the object reads by its own path. The exposure in the shipped runner is
narrow — the CLI grants the workspace right after creating it, and a fresh workspace cannot hold a pre-existing link — and it is **documented rather than fixed**, with
`AT-V3-HL-05` asserting the behaviour as it exists so it cannot regress into a claim.

**V-3.1/V-3.2 hard-link hardening is implemented and verified, uncommitted pending owner review.** The grant-time defect is fixed at the source: `createWorkspace` runs
the container grant inside a hard-link gate (`src/exec/hardlink-defect-remediation.mjs`) that scans the workspace before the grant (refusing
`WORKSPACE_HARD_LINK_PRE_GRANT`) and again after it, stripping any container ACE that landed through a link and refusing `WORKSPACE_HARD_LINK_GRANT_ESCAPED`; the strip
is `/inheritance:d` then `/remove`, because a bare `/remove` through the link reports success while the ACE is inherited straight back. The race is real — a watcher
process won it **20/20** against the ungated code (grant window 9.51–18.89 ms) — so the "narrow exposure" claim above held only against a passive attacker. V-3.2
closed the remaining edge cases: UNC (`\\?\UNC\`) and `\\?\GLOBALROOT` link targets are refused at creation for the user and the container alike, a junction planted
before the grant propagates no ACE and is refused at run time, a `FILE_SHARE_NONE` lock neither hides the link count from the scan nor blocks the ACE cleanup, and a
link planted after the grant lands no ACE and reads `EPERM` through both names. The runner now refuses a workspace with broken containment (`WORKSPACE_LINK_ESCAPES`
for a junction, `WORKSPACE_HARD_LINK_PRESENT` for a second name) before any tool runs — the task-id branch of `checkExecutionBoundary` existed but no production caller
passed one, so the junction refusal had never fired. Gates: `npm test` 255/255 (239 → 248 → 255), `npm run verify` 8/8, no new TODO markers. Evidence, verdict
(Partially Secure, mitigated) and reproduction steps: `docs/research/v3-read-isolation/hardlink-investigation.md`.

**A defect this milestone found in its own reporting.** Until `a7c532a`, a `kernel` run **passed the boundary check and then launched the tool with the user's own
read rights**: the SID the CLI resolved was handed to the helper as a profile *name*, deriving from a string that was already a SID returned `0x80070057`, and the
run failed closed with `CONTAINER_UNAVAILABLE` rather than running unconfinement — but the posture was, for that period, a promise the run path did not keep. The
correct fix is in two places on purpose: `src/exec/job.mjs` translates a SID back to the profile name, and `job_host.py` also accepts a literal SID through
`ConvertStringSidToSidW`, because either side working alone is a boundary that depends on the other never changing.

**Five ceilings are stated rather than implied.** `CEILINGS` carries one row per ceiling with `enforced_by` of `job_object`, `timer`, `buffer`, `counter` or `none`.
Three are `none` and say why: `max_processes`, because `JOB_OBJECT_LIMIT_ACTIVE_PROCESS` counts the process doing the spawning and a limit of 1 fails its first
`CreateProcess` with `WinError 1816 ERROR_NOT_ENOUGH_QUOTA`; the per-process time ceiling, because `JOB_OBJECT_LIMIT_PROCESS_TIME` never fires at all; and the
tool-call ceiling at the tool layer, which the task runner now enforces by spending one counter per invocation at admission. Job time is user-mode CPU time, so the
overshoot is load-dependent — measured between 2.07 s and 8.13 s for a 1000 ms ceiling over an 8 s burn — and is recorded as a range rather than a number.

**The house style is written down and applied.** `docs/implementation/code-style.md` records it, `AGENTS.md` points at it, and `src/tasks/states.mjs` is the reference
implementation. The pass removed comments that restated the code and kept every measured fact and reasoned decision; a comment-stripping diff proved the code lines
identical in each file it touched.

**Every gate is green.** `npm test` 232 of 232, `node tools/verify.mjs` `checks=8 pass=8 fail=0`, `--self-test` 8 of 8, `type_errors: 0`, `owned_violations: 0`, and
`npm run verify` passes with the secret scan required; there is no advisory skip left in any check.

**Correction, 2026-11-08 evening: the model was never missing.** This record and the M-2 preflight both said the ollama daemon was not listening and no model was
pulled. The daemon was indeed down, but the model — `qwen3-4b-instruct-2507:latest`, digest `1a2c1c9c3f3b02803c567e3b720166f6391eea1c0d5759e32c3655ba97355137`,
2.33 GB, Q4_K_M, 4.0 B parameters — has been on disk since about 2026-10-25, and the digest matches OD-8's pin exactly. Starting the daemon and calling the model
returned `READY` in 12.8 s of which 12.4 s was load time; the generation itself was two tokens. So the fact asserted was wrong rather than stale: the capability was
there the whole time and nobody had started the service. Recorded because a claim repeated across several documents is exactly the kind that stops being checked.

## Constraints to preserve

- Keep Lain independent; DSH and prior projects are research inputs, not source to import.
- Do not silently promote proposed technology candidates or open decisions to accepted decisions. The event-store ownership recommendation, the M-2 decision
  register and the Tier 1 containment choice are recommendations until the user accepts them.
- Preserve cost, privacy, authorization, provenance, and approval boundaries in `AGENTS.md`, `DECISIONS.md`, `ARCHITECTURE.md`, and `SECURITY_MODEL.md`.
- Treat external content as untrusted and never store credentials as ordinary memory.
- Never describe this system as containerised, sandboxed, or VM-isolated. The measured ceiling is in `SECURITY_MODEL.md` §10, and the permitted sentence ends
  "Lain is not a sandbox."
- **No push without explicit permission**, and never amend or rewrite published history. `main` is now in sync with `origin/main`; a further push needs a further
  explicit approval.

## Next action

V-2 is complete and its evidence is recorded, every gate is green, and the work past the published tip is local. What remains needs a decision rather than a keystroke:

1. **Publishing the five V-2 commits.** The owner approved the push that produced `c204604` and I published it; `98e52d0`, `d2f152a`, `a6911bf`, `be1b501` and
   `9ba13a7` came after that approval, so they are held. They are a fast-forward from `c204604` — no rewrite, no force, no tags — and `npm run verify` is green at
   `9ba13a7`. A further push needs a further explicit approval.
2. **The M-2 authorization question**: whether to build the model loop. The model-binding precondition is **satisfied and measured** — the ollama daemon is serving
   and the pinned model (`qwen3-4b-instruct-2507:latest`, digest `1a2c1c9c3f3b…`) answered a real call. D-P4's blocking condition is cleared; what remains is the
   authorization itself. No model, network or native containment work is authorized yet, and V-2 came first by the owner's instruction.
3. **What V-2 did not do**, stated here rather than discovered later: reads are still unrestricted; the network is still policy-only; AppContainer/LPAC is
   unmeasured; the supervisor is a soft target, so anything holding its PID can kill it and anything that can write the helper can change what it enforces — the
   helper hash and the settle record make that visible, not impossible; `JOB_OBJECT_LIMIT_JOB_MEMORY` is wired but was never measured; and the supervisor's own
   timeout path is not driven by a test.
4. **D-P10**: `VISION.md` and the numeric-threshold rewrite of `ACCEPTANCE_TESTS.md`, which wait until the M-2 scope freezes.

**Backups are same-disk only** (the machine has one physical disk), so `origin` is now the only genuinely off-machine copy; removable media remains the follow-up
D-P1 named.

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
