# 10 — M-2 Implementation Sequence

**Status:** PROPOSED plan. **Nothing has been executed. M-2 is not authorized.**
**Date:** 2026-11-08
**Scope:** the ordered path from the verified M-1 foundation to a first bounded agent that can prove what it did.
**Verification classification:** PROPOSED throughout; each step's acceptance criteria are stated so a later run can mark them VERIFIED or not.

**Ordering rules (ESR).** Deterministic components before anything model-driven, because they can be proven on this machine today. Containment before tools, because a tool that runs outside the boundary invalidates the boundary claim. Policy before execution, because ADR-004 makes authorization structural — a tool layer that decides for itself is the failure the whole architecture exists to prevent. The model loop last, because it is the only piece that cannot be tested without everything else.

---

## Step 1 — Backup independence (independent of M-2)

- **Objective:** close the largest protection gap: the implementation and 19 commits exist on one physical disk.
- **Prerequisites:** none. Needs decision **D-P1**.
- **Files:** none in the repository (a push and/or a copy to removable media).
- **Acceptance:** the commits are recoverable from a device other than Disk #0, proven by restoring a commit hash list from that device; if pushing, `git ls-remote origin refs/heads/main` shows the local HEAD.
- **Tests:** restoration of the commit list from the second copy.
- **Risks:** pushing publishes work that has been private so far (reversible); removable media may not exist (then the risk is *recorded*, not fixed).
- **Rollback:** a push can be reverted on the remote; a copy can be deleted.
- **User decision:** **YES (D-P1).**

## Step 2 — Containment helper, measured before anything depends on it

- **Objective:** turn Verification E from a PowerShell experiment into a reusable, tested component, and confirm the properties the design assumes.
- **Prerequisites:** Step 1 completed or explicitly deferred.
- **Files (future):** `src/exec/containment.mjs`, `src/exec/job.mjs`, `native/` helper (a small purpose-built addon or `koffi` binding — **decision required**, see risks), `test/exec/{containment,job}.test.mjs`.
- **Acceptance:** (a) a child runs at Low IL in a labelled workspace; (b) a write outside it is refused **and the artefact is absent**; (c) the same write inside succeeds (positive control); (d) `KILL_ON_JOB_CLOSE` terminates the tree when the controller dies; (e) job memory and CPU-time limits terminate a deliberately over-limit child while an under-limit child completes; (f) a tool that tries to create its own job is detected and surfaced as a defect.
- **Tests:** AT-BD-01…08, each with its positive control, in isolated temp directories with self-cleanup.
- **Risks:** (i) **the binding decision** — a purpose-built addon is more code to maintain, a general binding like `koffi` is a dependency that needs justification under the minimal-dependency constraint (audit OD-9 deferred this to "after the spike"; the spike is now); (ii) Node may already be inside a job, so `AssignProcessToJobObject` can fail — that must be detected and reported, not worked around; (iii) job assignment of a child that exits immediately (the documented race) closed by creating children suspended.
- **Rollback:** delete the module; nothing else depends on it yet.
- **User decision:** the binding choice, if it exceeds the approved dependency policy.

## Step 3 — Policy Engine (`src/policy/`)

- **Objective:** a total `decide()` — every request produces a decision, never an exception and never a default allow — with the eight arms and the default arm `deny`.
- **Prerequisites:** Step 2 not required; needs **D-P5**, **D-P7**.
- **Files (future):** `src/policy/{decide,arms,approvals}.mjs`, a decision table fixture covering all eight arms, `test/policy/*.test.mjs`.
- **Acceptance:** every arm reachable and tested; `deny` is the default for an unknown request; an approval timeout yields `deny_indeterminate` **and is not retried**, while a user's `deny` may be re-requested after a documented change (positive control); every decision is recorded before the action it authorizes.
- **Tests:** arm coverage, default-deny, idempotent approval, timeout behaviour, and the store-boundary check staying green (no policy code inside `src/store/`).
- **Risks:** an arm that silently widens authority; approval state kept in memory instead of the store (a crash would forget a granted approval, or worse, remember one that was never granted).
- **Rollback:** delete `src/policy/`; nothing records decisions yet.
- **User decision:** **YES (D-P5, D-P7).**

## Step 4 — Task records

- **Objective:** the task contract as records, with the rule that **no checkable acceptance criterion means no admission**.
- **Prerequisites:** Steps 2–3; **D-P6**.
- **Files (future):** `src/tasks/{contract,store,states}.mjs`, schema fixtures, `test/tasks/*.test.mjs`.
- **Acceptance:** a task without a criterion is refused (`AT-M2-01`); illegal transitions are refused **and recorded**; a task's capability set cannot change after admission; a result with an empty `evidence[]` cannot reach `completed`.
- **Risks:** permissive schemas that admit unverifiable work; a state machine with an unrecorded terminal path.
- **Rollback:** delete `src/tasks/`; the event log keeps whatever was written, which is the point.

## Step 5 — Tool execution contract, with **no tools yet**

- **Objective:** the invocation path — decision required, effect class recorded, idempotency key, result schema, cancellation hook-up — proven with a stub tool.
- **Prerequisites:** Steps 2–4.
- **Files (future):** `src/tools/{registry,invoke,result}.mjs`, `test/tools/*.test.mjs`.
- **Acceptance:** execution **refuses to run without a `decision_id`** (`AT-M2-05`); `denied` is distinguishable from `error`; every invocation records its effect class and network class; the store-boundary and "no direct `child_process` outside `src/exec/`" checks stay green.
- **Risks:** the stub tool passing while the real ones would not — mitigated by making the stub exercise the full path including a deliberate policy denial.
- **Rollback:** delete `src/tools/`.

## Step 6 — The four tools

- **Objective:** `read_file`, `write_file`, `run_script`, `git_local` — each with a class, a contract and containment tests.
- **Prerequisites:** Step 5; **D-P3** (the containment ceiling must be accepted before tools exist).
- **Files (future):** `src/tools/{read-file,write-file,run-script,git-local}.mjs`, `test/tools/containment/*.test.mjs`.
- **Acceptance:** AT-BD-01…08 pass **through the real invocation path** (not just the helper); a tool cannot write outside its workspace; `git_local` operates only in a disposable repository.
- **Risks:** a tool that needs a writable location outside the workspace (npm/pip caches — OQ-BD-1) would either fail or force a shared Low-labelled region that weakens AT-BD-01. **This is the step where that decision becomes concrete.**
- **Rollback:** remove a tool from the registry; the others are unaffected.

## Step 7 — Cancellation

- **Objective:** the ten-step lifecycle from [01-cancellation-semantics.md](01-cancellation-semantics.md), including the ordering rule that the terminal record precedes the kill.
- **Prerequisites:** Steps 2 and 6; **D-P2**.
- **Files (future):** `src/exec/cancel.mjs`, `test/exec/cancellation.test.mjs`.
- **Acceptance:** AT-CX-01…10, including 0 surviving processes in 20/20 runs, `cancel_failed`/`escalated` distinct from `cancelled`, and a controller-kill test where the OS cleans up.
- **Risks:** the documented intermediate-process job escape — mitigated by enumeration rather than trust; a cancellation that reports success it cannot prove, which AT-CX-08 exists to catch.
- **Rollback:** cancellation is additive; removing it leaves the honest state where a task cannot be stopped.

## Step 8 — Model binding adapter

- **Objective:** one adapter (protocol, not provider), digest verification, cost classification, timestamped model call.
- **Prerequisites:** Step 3 (a decision must exist to authorize a call); **D-P4**; free VRAM verified before the binding is declared usable.
- **Files (future):** `src/models/{binding,adapter-ollama,digest}.mjs`, `test/models/*.test.mjs`.
- **Acceptance:** AT-MB-01…09; a mismatch refuses before any task work; `unknown` cost refuses and records; a timeout is recorded as **unknown outcome** and never retried.
- **Risks:** OQ-MB-3 — Ollama may not expose enough to verify the digest of the served weights. If it does not, R-1 cannot be satisfied as specified and the binding contract must change **deliberately** rather than silently.
- **Rollback:** delete `src/models/`; no task can then run a model, which is the current state anyway.

## Step 9 — The bounded loop

- **Objective:** the seven-step loop with every stopping condition recorded, ending in a result with `claims`, `artifacts`, `evidence`, `checks`, `not_verified`, `indeterminate`.
- **Prerequisites:** Steps 4–8 complete.
- **Files (future):** `src/agent/{loop,context,stop}.mjs`, `test/agent/*.test.mjs`.
- **Acceptance:** AT-M2-01…10 plus AT-BD and AT-CX suites green; the guaranteed task (D-P8 option a) completes end to end with evidence; a hard kill mid-loop leaves `indeterminate`, never a fabricated completion.
- **Risks:** context growth across turns (mitigated by using only the last tool result); the model's tool-calling reliability (the reason the P0 spike is a precondition); a loop that keeps going because its stopping conditions are checked after the fact rather than before.
- **Rollback:** the loop is the last addition; removing it returns the system to "components that are individually tested and do nothing on their own".

## Step 10 — Verification and freeze

- **Objective:** prove the whole slice, record what is not proven, and stop.
- **Prerequisites:** Steps 1–9.
- **Acceptance:** `npm test`, `npm run check` and `check:self` green; the required gate green **or** its absence recorded (D-P9); every AT-* result retained with its positive control; the `not_verified`/`not_testable` list explicit; `CURRENT_STATE.md` updated to describe what now exists.
- **Risks:** declaring success from a green suite that cannot fail (mitigated by `check:self`); scope creep into Phases 5–8.

---

## What must not be built during M-2

**ESR.** Delegation, the capability-scoring router, the evaluation lab, the research lab, the opportunity registry, the extension platform, the knowledge graph, embeddings, the desktop UI, unattended operation, and **any** tool outside the four in Step 6. Each depends on primitives that do not exist, and building them now reproduces the failure the research warned about: simulated capability with no substrate.

## Sequencing risks, stated plainly

1. **The largest risk is environmental, not architectural:** Step 1 is the only step whose cost is measured in *lost work* rather than design time, and it is the one that needs no engineering.
2. **Step 2 is where a measured boundary becomes a dependency.** If the job-assignment or limit behaviour does not hold on this machine, every later step's containment claim is wrong — which is exactly why it comes second and is measured before it is depended on.
3. **Step 6's cache question (OQ-BD-1) can quietly weaken AT-BD-01.** The temptation will be to add one shared writable directory "just for caches"; that decision must be explicit and its cost stated.
4. **Step 8 can invalidate its own contract.** If digest verification is infeasible, the honest response is to change the contract, not to loosen R-1 in silence.
