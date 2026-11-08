# 11 — Final Preflight Report

**Status:** Preflight complete. **M-2 is not authorized, not started, and not implemented.**
**Date:** 2026-11-08
**Scope:** the whole M-2 Preflight assignment — backup, cancellation, containment, readiness, and the specification to review.
**Verification classification:** every claim below is labelled VERIFIED (measured in this session or a recorded one), DOCUMENTED (official Microsoft documentation), PROPOSED/RECOMMENDED, or UNRESOLVED. Where something could not be established it is marked **NOT-TESTABLE** rather than inferred.

---

## A. Repository state

| Field | Verified value |
|---|---|
| Repository root | `C:/Users/frick/Documents/Projects/lain` |
| Branch / HEAD | `main` / `d5452f1cb51aa87961511a56f047206e6e06a81d` |
| Commits | **19** |
| Tracking | `main...origin/main [ahead 11]`; live remote `main` still `7074c0dbad9ade15bc2a1017087386bbb058c760` |
| Tracked files / staged / modified | **91** / 0 / 0 — working tree clean |
| Identity | local `lain <lixkirb@gmail.com>`; global empty |
| Protected locations | archive B `0e7fdee`; `.lain-audit` 144 files / 149 585 363 B; V bundle `D9277951…`; W 161 files; M-1 backup 39 files — **all unchanged** |

No discrepancy with the reported state, so no stop condition applied and nothing was abandoned.

## B. Backup

**Created and restore-verified.** Destination `C:\Users\frick\Documents\Projects\lain-m2-backup-2026-11-08`, artifacts kept **outside** the tree in `…-artifacts\`.

- **Physical volume: one disk.** `Win32_DiskDrive` shows a single `1TB SSD`; `Win32_LogicalDiskToPartition` maps both `C:` and `D:` to **Disk #0**. No removable media present. So this is **SAME-DISK PROTECTION ONLY** — recorded in `BACKUP-INFO.txt` in those words.
- **305 files / 1 920 649 bytes**, including `.git` with all **19 commits**; excluded by design: `.lain-audit`, `node_modules`, `artifacts`; 0 symlinks.
- **Manifest: 305 rows, 305 `MATCH`, 0 `MISMATCH`, 0 `MUTABLE-DRIFT`.**
- **Restore test** (isolated `%TEMP%` destination, then removed): 305 restored, 0 mismatches, and from the restored copy alone **HEAD `d5452f1`, 19 commits, branch `main`, `git diff` empty, `git status` empty**, `fsck --strict` clean apart from a harmless pre-existing dangling blob. Nothing from the restore was executed and no dependency was installed.
- **Two provenance defects found and fixed:** the first run wrote its manifest *inside* the tree (so the copy no longer matched the source), and it hashed `.git/index` as if immutable — that file is Git's stat cache and changed from `88FDBEFB…` to `32B6EAC2…` to `9CC7BF24…` as git commands ran. It is now classified `MUTABLE-DRIFT`.
- **Verdict: restore-verified for content and history; genuine independence UNRESOLVED.**

## C. Cancellation

- **Compared:** immediate, safe-point, and hybrid — across 13 dimensions (latency, transaction integrity, child behaviour, side effects, partial results, cleanup, orphan risk, idempotency, retry safety, audit events, resources, Windows complexity, recovery). The comparison is in [01-cancellation-semantics.md](01-cancellation-semantics.md) §2.
- **Recommended (RECOMMENDED, not decided): Model C — hybrid by effect class.** The narrow justification: A and B differ only in what they do to an *in-flight effect*, and Lain already has a declared vocabulary for exactly that difference (the Phase 5 effect classes). Where the class is unknown it is treated as `external`, so a mislabeled tool degrades to asking a human rather than to an irreversible action.
- **Lifecycle:** request → close admission → acknowledge what is in flight → **write the terminal intent before any kill** → act per class → `TerminateJobObject` → settle the store → **enumerate and record survivors** → escalate on timeout → `cancelled` only if verification passed, else `cancel_failed`.
- **Key rules:** a timeout never means success; an unknown outcome is never blindly retried; the class is a tool-contract property checked at load, never a model decision; `cancelling → completed` is illegal (the task still ends `cancelled`).
- **Acceptance criteria:** AT-CX-01…10, with positive controls, including 0 surviving processes in 20/20 runs and a controller-kill test.

## D. Containment

- **Mechanisms evaluated against official documentation:** MIC and integrity levels, restricted tokens, Job Objects (breakaway flags, kill-on-close, nested jobs, memory/CPU/process limits, the 100 ns unit trap), AppContainer/LPAC (network, window, process and credential isolation; dual-principal DACL intersection), filesystem ACLs, network restriction, credential isolation, temporary-workspace isolation, child-process lifecycle.
- **Tested evidence (VERIFIED):** MIC + restricted token + Low IL workspace refuses writes outside the workspace on this machine — four denied escape attempts with every artefact confirmed absent, and the same write inside succeeding as the positive control; Node 24.21.0, Git 2.56 and Python 3.15 all do bounded work at Low IL; 9 of 11 redirect/path escape classes were contained in Phase 0 with 2 NOT-TESTABLE on this volume.
- **Untested guarantees (DOCUMENTED or UNRESOLVED):** Job Object limits and kill-on-close are documented but no Lain code exercises them; AppContainer/LPAC would address the read, network and UI gaps but **whether the toolchain runs inside it is unknown**; **reads are not restricted**; **network is not restricted**; **UI/COM is not isolated**; **resource limits are configured but unverified**.
- **Recommended architecture:** Tier 1 for M-2 (restricted token + Low IL workspace + Job Object, no breakaway, network declared out of scope, reads declared unrestricted, UI/COM untested), with Tier 2 (AppContainer/LPAC) as an explicit future **measured** experiment rather than a promise.
- **The only permitted sentence** ends: "**Lain is not a sandbox.**"

## E. Threat model

Assets ranked A-1…A-8; the central asymmetry that **model output is untrusted input and a tool process is an untrusted executor, so no security decision may be an instruction to the model**; nine trust boundaries, of which **B-6 (network) is unenforced** and **B-7 (UI/COM) untested**; seven attack surfaces; seven objectives each with its test; explicit non-goals (kernel exploits, local admin, physical access, supply chain, multi-user). **Residual risk stated plainly:** an agent whose actions were all permitted could today read any file the user can read, write inside its own workspace, reach the network and run code — while unable to write outside the workspace, survive cancellation, or change its own permissions. The gaps that matter are **reads first, network second**.

## F. Execution contract

Task contract with **no checkable acceptance criterion → not admitted**; capabilities immutable after admission; objective stored verbatim; no transcript in the record (measured rationale: a system prompt, three tool schemas and one tool result already consume 15.1 % of a 4 096-token window). Seven-step lifecycle with every stopping condition recorded. Result schema with the asymmetry **"a claim is never sufficient; evidence may be"**. Tool authorization that **refuses to run without a recorded `decision_id`**, distinguishes `denied` from `error`, and records effect class, idempotency key and declared network class. Model binding with digest-required, cost-class-fail-closed, no-fallback, deterministic selection and the unknown-outcome timeout rule. The v0.1 tool set is four tools, and the exclusions are argued rather than assumed.

## G. M-2 readiness

- **Implemented and verified:** build/check environment; event store (single write transaction, redaction, recovery, tamper detection).
- **Implemented, partially verified:** host probe; resource admission (limits are RECOMMENDED, never observed under load); containment *mechanism* (measured as an experiment, not integrated).
- **Specified only:** Policy Engine, task records, model binding, tool contract, result recording, approval flow, grant records.
- **Unresolved:** off-device backup; secret scanner; digest verification feasibility for an Ollama-served model.
- **Out of scope for M-2:** read and network restriction, UI/COM isolation, multi-agent orchestration, knowledge graph, embeddings, plugins/MCP/Creator Mode/Mods, desktop UI, unattended operation.
- **Blockers, in order:** **D-P3** (is the containment ceiling acceptable), **D-P2** (cancellation model), **D-P5** (real Policy Engine or a hard-coded list), then **D-P4** (binding + P0 spike) and **D-P1** (protection).

## H. Git state

- **Files created by this assignment:** twelve documents under `docs/research/m2-preflight/` — `README.md`, `00-backup-and-recovery.md`, `01-cancellation-semantics.md`, `02-windows-containment-research.md`, `03-threat-model.md`, `04-filesystem-process-network-boundaries.md`, `05-resource-and-lifecycle-contracts.md`, `06-bounded-agent-execution-contract.md`, `07-model-binding-contract.md`, `08-dependency-and-readiness-matrix.md`, `09-open-decisions.md`, `10-m2-implementation-sequence.md`.
- **Corrections to existing files:** one — `07-model-binding-contract.md` had a resource/limit section that belonged in its own document; the section was moved verbatim into `05-resource-and-lifecycle-contracts.md` and replaced by a cross-reference, so limits are stated in exactly one place.
- **Canonical documents modified: none.** No recommendation was promoted into an accepted decision.
- **Commit:** one local documentation commit, `docs: prepare M-2 execution and containment preflight`, created only after the test suite was re-run green (110/110 and 7 pass / 1 advisory skip).
- **No push, no fetch, no pull, no branch change, no amend, no history rewrite, no protected location modified, no dependency installed, no security setting changed, no model called, no credential created or used.**

## I. Recommended next action

**Decide D-P3 (is the containment ceiling acceptable for M-2) and D-P1 (off-device protection) — in that order of consequence, in either order of convenience.** D-P3 is the gate: it determines what the first tools may do and what sentence Lain is allowed to say about itself, and it is the decision every later step inherits. D-P1 costs one sentence and closes the only risk on this list measured in *lost work* rather than design time.

**Do not start M-2.** The five prerequisites named in the readiness review are not all met, this assignment explicitly did not authorize implementation, and Lain's own constraint is the right one here: **execution authority has to be earned through verified boundaries, not architectural promises.**
