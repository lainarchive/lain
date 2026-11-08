# 07 — Open Decisions

**Status:** Register of decisions that this verification assignment produced or sharpened. **Nothing here is decided.**
**Date:** 2026-11-08
**Labels:** VERIFIED (measured in this assignment) · REC (recommendation, not a decision) · OPEN (needs the user) · CONSEQUENCE (what happens if it is left alone).

## Blocking — needed before M-2 can be authorized

### D-V1. Cancellation semantics (hybrid by effect class)
- **Options:** immediate kill; safe-point; hybrid driven by the declared effect class.
- **REC:** hybrid — immediate for `none`/`local_reversible`, safe-point for `local_irreversible`, never automatic for `external`, with the terminal record written before any kill and zero-orphan verification afterwards.
- **Blocks:** the whole tool-execution path; a cancellation that cannot be verified makes every later "the task was stopped" claim unfalsifiable.
- **Reversibility:** moderate — the choice is embedded in the loop's control flow once written.

### D-V2. The model-binding contract and the pinned binding
- **Options:** adopt the ten rules in [06](06-m2-readiness-review.md) §9.2 as written; adopt a subset; defer.
- **REC:** adopt as written, and treat the digest (`sha256`) as the model's identity rather than its tag.
- **Blocks:** M-2.1. Without it, "which model ran" is not a recordable fact.
- **Reversibility:** high before code, low after events exist that name bindings.

### D-V3. Read boundary, or an accepted limit
- **Options:** (a) declare read access an accepted limit for v0.1 and say so; (b) design a read boundary (separate Low-IL account with restricted ACLs, or a read-filtered mount); (c) postpone.
- **REC: (a) for v0.1, stated explicitly in `SECURITY_MODEL.md`.** MIC is not a confidentiality mechanism; claiming otherwise would be the same defect the earlier audit found in the container/VM promise. **(b)** becomes worthwhile only when Lain handles data the user would not show it.
- **Blocks:** the wording of every containment claim. **CONSEQUENCE of silence:** readers assume isolation implies confidentiality.

### D-V4. Resource limits for contained processes
- **Options:** (a) Job Object memory/CPU limits before any tool execution; (b) no limits in v0.1, with the absence recorded.
- **REC:** (a) before any model-driven tool runs, because an unbounded child on a 4-thread machine can starve the store writer and the agent itself. The measured VRAM/RAM figures in `RESOURCE_BUDGET.md` make the ceiling concrete.
- **Blocks:** M-2.2. **Reversibility:** high.

### D-V5. Backup coverage for implementation code
- **Evidence (VERIFIED):** the M-1 backup restores perfectly (37/37, 0 mismatches) but was taken **before** any implementation existed. `src/`, `test/`, `tools/`, `package.json`, `tsconfig.json`, `RESOURCE_BUDGET.md` and the three corrected documents are in **no** backup. The only copies outside the working tree are 18 local commits in `.git` on one disk.
- **Options:** (a) take a new independent backup now and after each milestone; (b) push to the remote (currently forbidden); (c) rely on the local repository.
- **REC: (a)** — cheap, requires no authority beyond creating a new destination, and it closes the single largest single-point-of-failure in the project today.
- **Blocks:** nothing technically; it is a risk decision. **CONSEQUENCE of silence:** one disk failure loses M-1 entirely.

## Needed, but not blocking M-1 or M-2

| # | Question | REC | Notes |
|---|---|---|---|
| D-V6 | Install `gitleaks` from the prebuilt Windows release? | **Yes, when the user wants the required gate to pass** | $0; the gate stays red until then, which is correct |
| D-V7 | Should the ownership *model* (a distinct Event Store) become an accepted decision? | **Not yet** | The implemented guarantee is now documented accurately; the architecture question has no consumer pressing it |
| D-V8 | Renormalise the working tree once `.gitattributes` is in place? | **Defer again** (already deferred once) | Each deferral costs nothing while the format gate stays advisory for canonical documents |
| D-V9 | Publish the 18 local commits, or keep holding? | **User's call; still held** | Every brief so far has forbidden pushing; the consolidation is now complete, so the original condition for holding has been met and the decision is live |
| D-V10 | Canonical numeric thresholds for `ACCEPTANCE_TESTS.md` | Adopt the `14-acceptance-criteria.md` set, replacing **P** entries with measurements as they land | Still open from the audit; unrelated to M-2 |
| D-V11 | `VISION.md` and the income objective | **Write it**, marking long-term capabilities out of scope for v0.1 | Still open; the repository still does not state its own mission |

## What is deliberately **not** on this list

Anything settled by measurement in this assignment:

- **Is the store's writer guarantee transaction serialization or continuous ownership?** Transaction serialization — measured, and the documentation now says so.
- **Is the backup restorable?** Yes — restore-verified.
- **Does the required security gate fail closed?** Yes — exit 1 while `gitleaks` is missing.
- **Can the toolchain work at Low IL?** Yes, with the write boundary holding — measured with positive and negative controls.
- **Does `WRITE_RESTRICTED` with no restricting SIDs work?** No — it silently produces a child that does nothing; recorded so it is not rediscovered.

Re-opening any of these would be re-litigating a measurement.
