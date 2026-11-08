# Lain — M-2 Preflight: Backup, Cancellation & Containment Architecture

**Status:** Preflight complete. **M-2 is NOT authorized and NOT implemented.**
**Date:** 2026-11-08
**Base revision:** `d5452f1cb51aa87961511a56f047206e6e06a81d` (19 commits, `main`, 11 ahead of `origin/main`, nothing pushed).
**Verification classification:** VERIFIED · HISTORICAL · DOCUMENTED · PROPOSED · RECOMMENDED · UNRESOLVED · NOT-TESTABLE. Each document states which applies to each claim.

---

## What this package is

The preparation Lain needed before its first bounded agent could be built honestly: the implementation is backed up and restore-verified, the cancellation question is answered with a recommendation, the containment boundary is stated in terms of what was measured rather than what sounds strong, and the execution contract is small enough to test.

## The one-line conclusion

**The foundation is verified, the boundary is real but narrow, and M-2's blockers are three components — not ten.** Policy, task records and execution integration block everything else; reads and network remain unenforced and are declared as such.

## Documents

| File | What it answers |
|---|---|
| [00-backup-and-recovery.md](00-backup-and-recovery.md) | Where the implementation is protected, how it was verified, and the one protection it does **not** have |
| [01-cancellation-semantics.md](01-cancellation-semantics.md) | D-V1: which cancellation model, why, the lifecycle, the illegal transitions, the acceptance tests |
| [02-windows-containment-research.md](02-windows-containment-research.md) | Which Windows mechanisms Lain can rely on, what was measured, and the two-tier recommendation |
| [03-threat-model.md](03-threat-model.md) | Assets, adversaries, nine trust boundaries, residual risk, and what the agent could actually do today |
| [04-filesystem-process-network-boundaries.md](04-filesystem-process-network-boundaries.md) | The enforcement design: paths, labelling, job rules, limits, network as policy, credentials |
| [05-resource-and-lifecycle-contracts.md](05-resource-and-lifecycle-contracts.md) | Every limit labelled M/CFG/REC/HIST, the admission rule, the five lifecycle phases |
| [06-bounded-agent-execution-contract.md](06-bounded-agent-execution-contract.md) | The task contract, lifecycle, result schema, tool authorization, the four-tool v0.1 set |
| [07-model-binding-contract.md](07-model-binding-contract.md) | Binding identity, eleven rules, call semantics, error classes, provenance |
| [08-dependency-and-readiness-matrix.md](08-dependency-and-readiness-matrix.md) | All 25 dependencies with their true state, and what must not be built yet |
| [09-open-decisions.md](09-open-decisions.md) | What needs a human decision, and what measurement already settled |
| [10-m2-implementation-sequence.md](10-m2-implementation-sequence.md) | The ordered path with acceptance criteria, risks and reversal |

## Three things a reader should take away

1. **The backup protects content and history, and shares a disk with the original.** Restore-verified: 305 files, 1 920 649 bytes, 0 mismatches, 19 commits recovered. Same-disk protection only — an independent copy remains unresolved because the machine has one physical disk.
2. **Cancellation is recommended as hybrid by effect class, and the recommendation is narrow:** the classes already exist in the research, the difference between immediate and safe-point kill is exactly what they distinguish, and an unknown class fails toward asking a human.
3. **The containment sentence is fixed, and it ends "Lain is not a sandbox."** Writes outside the workspace are refused by MIC — measured. **Reads are not restricted, network is not restricted, UI/COM is not isolated, and resource limits are configured but unverified.**

## Correction, 2026-11-08 (owner-authorized, after this package was committed)

This package states in [07-model-binding-contract.md](07-model-binding-contract.md) that the ollama daemon is not listening and that D-P4's blocking condition is the missing model. **The daemon half was true; the model half was false.** Starting the daemon and querying it found `qwen3-4b-instruct-2507:latest` already on disk — digest `1a2c1c9c3f3b02803c567e3b720166f6391eea1c0d5759e32c3655ba97355137`, 2.33 GB, Q4_K_M, 4.0 B parameters, present since about 2026-10-25. The digest matches **OD-8's pin exactly**, and a real call returned `READY` (12.8 s, of which 12.4 s was model load). So **D-P4's precondition is satisfied**, not blocked. The correction is recorded rather than edited in place because the original measurement is part of the package's provenance: what failed was not the measurement but the inference drawn from it — "no daemon" was written down as "no model", and that claim then propagated into three other documents.

**What this does not change:** no M-2 work is authorized. A binding that *can* be tested is not the same as a binding that has been built, and the package's other conclusions — Tier 1 containment, reads and network out of scope, cancellation model C — are untouched by this correction.

## What this package deliberately does not do

It does not implement anything, does not call a model, does not install anything, does not weaken a Windows protection to make an experiment pass, does not claim a sandbox, and does not promote any recommendation into an accepted decision. Every recommendation is labelled, and the canonical documents were not modified.

## Provenance

Built on M-1 Steps 0–3 (`38a5e66`) and the M-1 Verification Closure (`d5452f1`), both independently verified. The measurements this package relies on are in [docs/research/m1-verification-closure/](../m1-verification-closure/README.md) — in particular the low-integrity toolchain experiment, which is the only reason the containment claims here are statements about this machine rather than about a design.
