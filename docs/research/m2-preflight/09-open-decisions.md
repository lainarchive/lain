# 09 — Open Decisions

**Status:** Decision register for the M-2 preflight. **Nothing here is decided.** Each entry gives the options, a recommendation **labelled as a recommendation**, what it blocks, and what measurement already settled.
**Date:** 2026-11-08
**Verification classification:** RECOMMENDED (a proposal with evidence) · UNRESOLVED · VERIFIED (already settled by measurement — listed in §3 so it is not re-opened).

---

## 1. Decisions needed

### D-P1 — Off-device protection for the implementation
- **Options.** (a) Accept same-disk protection and record the risk. (b) Obtain removable media and copy. (c) Authorize pushing the 11 local commits to `origin` as a third copy.
- **Recommendation (RECOMMENDED): (c) then (b).** Pushing is free, immediate and already available; it is currently held only because the earlier consolidation instruction said to hold pushes until review, and that review has happened twice since. **(b)** requires hardware; **(a)** is honest but leaves the single largest protection gap open.
- **Blocks:** nothing technically. It bounds how much work can be lost at once.
- **Reversibility:** high — a push is additive and the remote is private.

### D-P2 — Cancellation model (D-V1, the primary architectural question)
- **Options.** A immediate · B safe-point · C hybrid by effect class.
- **Recommendation (RECOMMENDED): C**, as specified in [01-cancellation-semantics.md](01-cancellation-semantics.md), with the narrow justification that the effect classes already exist in the research and distinguish exactly the thing A and B differ on. Unknown class → treated as `external` → ask a human.
- **Sub-decisions it carries:** the default deadline (30 s proposed), whether a cancelled task's partial artifacts are kept, quarantined or deleted, whether `cancel_failed` may retry the kill once, and whether `local_transactional` earns its own class.
- **Blocks:** the tool-execution path, the job-handle lifecycle, and every AT-CX test.
- **Reversibility:** the lifecycle is cheap to change before code exists; **the classification of a given tool is expensive to change afterwards**, because events recorded under one classification cannot be reinterpreted.

### D-P3 — Is the containment ceiling acceptable for M-2?
- **Options.** (a) Accept Tier 1 (write boundary + process-tree ownership) with reads and network declared out of scope. (b) Require the read gap be closed before any tool executes. (c) Require AppContainer/LPAC first.
- **Recommendation (RECOMMENDED): (a), with the limitation stated in the same sentence as the capability everywhere.** The measured boundary stops careless and confused writes and guarantees process cleanup; **(b)** needs a mechanism Lain does not have (a broker process or AppContainer), and **(c)** trades a measured boundary for a documented-but-unmeasured one — the exact mistake that produced the container/VM defect (S-1) the audit corrected.
- **Blocks:** every containment claim, the tool set's usefulness, and the wording of `SECURITY_MODEL.md`.
- **Reversibility:** moderate; narrowing later is easy, walking back a claim made in public is not.

### D-P4 — Is the model binding settled? (carries D-V2)
- **Options.** (a) Accept `qwen3-4b-instruct-2507` at digest `1a2c1c9c3f3b…` with the P0 spike as a **precondition** of the first model call. (b) Accept it and discover reliability while building. (c) Choose a different binding.
- **Recommendation (RECOMMENDED): (a).** The spike answers whether a ≤ 4 B model at 4 096 context can drive a tool-calling loop at all; discovering that by building the loop inverts the roadmap's own critique. **OQ-MB-3 (digest verification feasibility for an Ollama-served model) must also be answered by measurement, not by hope.**
- **Blocks:** the first model call and the loop.

### D-P5 — Policy Engine in M-2 scope, or a hard-coded allow-list?
- **Options.** (a) Build `src/policy/` with the total `decide()` and eight arms. (b) Use a static allow-list for the four tools and defer the engine. (c) A middle path: a two-arm decide (`allow`/`deny`) with the arm table as data.
- **Recommendation (RECOMMENDED): (a).** ADR-004 makes authorization external to prompts structural, and the store-boundary check exists to keep it that way; a hard-coded list would satisfy the letter of "outside the model" while removing the place where `require_approval` and `deny_indeterminate` live. **(c)** is the honest fallback if time is short, but it must be recorded as a temporary shape, not as the design.
- **Blocks:** every `invoke()` decision, the approval flow, and AT-M2-05/09.

### D-P6 — Where do task records live?
- **Options.** (a) Events only, with a projection. (b) Dedicated tables owned by the Task Manager, referencing the event log.
- **Recommendation (RECOMMENDED): (b)**, per the M-1 research: the store's job is persistence and ordering, and a task-table bug must not be able to corrupt the log. It also keeps the ownership question (D-V7-adjacent) narrow.
- **Blocks:** the task contract's implementation and the result reference.

### D-P7 — Approval surface for M-2
- **Options.** (a) CLI prompt with a timeout. (b) No approval path in M-2: every capability is granted at admission and `require_approval` is unreachable. (c) Defer both and keep the four tools inside pre-granted capabilities.
- **Recommendation (RECOMMENDED): (a)**, because "absence of approval is denial" needs somewhere to be observable, and a timeout produces `deny_indeterminate`, which is the distinction OD-7 exists to preserve. **(c)** is defensible for a first slice if recorded.
- **Blocks:** whether the `require_approval` arm is reachable at all in v0.1.

### D-P8 — The one task v0.1 must do end to end
- **Options.** (a) "Summarize a file into `summary.md`" — proves read + write + context, no model tool-calling skill required. (b) "Run a script and report its exit code" — proves execution + containment. (c) "Fix a failing test in a disposable repository" — proves the whole loop, and depends on the model's tool-calling reliability (D-P4).
- **Recommendation (RECOMMENDED): (a) as the guaranteed task and (c) as the stretch**, because (a) can be verified deterministically and (c) fails for reasons outside Lain's control if the model is weak.
- **Blocks:** the acceptance test that matters most, and the honest answer to "is v0.1 useful".

### D-P9 — Secret scanner (D-V6)
- **Recommendation (RECOMMENDED): install the prebuilt Windows gitleaks release** (no Go, no paid service), so `npm run verify` can pass. Until then the gate stays red, which is correct but means the required security check has never succeeded.
- **Blocks:** a green required verification run.

### D-P10 — Environment hygiene (deferred twice)
- Renormalisation of the legacy CRLF state stays deferred (decided m00883); the format gate stays advisory for canonical documents.
- **`VISION.md` and numeric thresholds for `ACCEPTANCE_TESTS.md` remain unwritten** and are the two canonical gaps M-1's own research flagged. **Recommendation: write them after M-2's scope is frozen**, because both are statements about the *finished* first release and would be guesses today.

## 2. Decisions that must be made before certain steps

| Before | Decisions |
|---|---|
| Any further protection work | D-P1 |
| Writing `src/policy/` | D-P5, D-P7 |
| Writing task records | D-P6 |
| Writing the tool layer | D-P2, D-P3 |
| The first model call | D-P4 |
| Declaring M-2 done | D-P8 |

## 3. What measurement already settled — do not re-open

- **MIC + restricted token + Low IL workspace enforces a write boundary** on this machine, with the toolchain working inside it (Verification E, 2026-11-08).
- **A container/VM guarantee is not available** here; the canonical promise was corrected to the measured ceiling.
- **The event store serializes write transactions, not process ownership** — reproduced; `STORE_LOCK_LOST` is a real outcome.
- **Batches are atomic and committed per append**; there is no partial batch to cancel.
- **`.git/index` is not byte-stable** and must not be treated as an integrity artefact.
- **A bare `powershell.exe` fails under `CreateProcessAsUserW`**; fully qualified paths are required.
- **`WRITE_RESTRICTED` with no restricting SIDs silently breaks the child** (exit 0, no work done).
- **Reads are not restricted by MIC**, and the default mandatory policy is `NO_WRITE_UP`.
- **Network access is not restricted by anything Lain builds today.**
- **The machine has one physical disk**, so same-directory copies are not independent.
- **`fs.flockSync` does not exist in Node 24.21.0 here.**

## 4. Recommendation ordering

**ESR.** Three decisions unblock the most work with the least commitment: **D-P3** (accepting or refusing the containment ceiling) determines what the first tools may do; **D-P2** determines how they stop; **D-P5** determines who says yes. **D-P1** is urgent but independent — it can be answered in a single sentence and should be, because it is the only item on this list whose cost is measured in lost work rather than in design time.
