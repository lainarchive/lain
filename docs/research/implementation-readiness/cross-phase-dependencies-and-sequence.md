# Dependency Graph, Implementation Readiness and Sequencing

**Status:** Research and synthesis. **Nothing here is an accepted decision, and nothing here has been implemented.**
**Base revision:** `36a3e18003ad41171be96d28cfbbda5b5304441c` (13 tracked files, no implementation source tree of any kind).
**Scope:** cross-phase dependencies between Phase 4 (documentation audit), Phases 5–8 research, and the Phase 0/1 foundation work the roadmap already names. This document answers: *what can be built now, what is blocked, why, and in what order.*

---

## 1. The dependency graph

```
                    ┌──────────────────────────────────────────────┐
                    │ DOCUMENTATION TRUTH LAYER (Phase 4)          │
                    │ C-1 events owner + single-writer rule        │
                    │ C-2 true containment ceiling                 │
                    │ C-3 remove "existing" claims                 │
                    │ C-4 VISION.md (non-normative)                │
                    │ C-5 CURRENT_STATE re-record                  │
                    │ C-8 numeric thresholds + RESOURCE_BUDGET     │
                    └───────────────┬──────────────────────────────┘
                                    │ corrects false claims; blocks nothing technically,
                                    │ but every later decision inherits these claims
                                    v
┌────────────────────────────────────────────────────────────────────────────┐
│ FOUNDATION (roadmap Phase 0/1, one canonical milestone)                    │
│                                                                            │
│  F-1 repo conventions + reproducible build/check command                   │
│  F-2 EVENT STORE: append-only, single writer, one txn per batch,           │
│      redaction on write, schema migration, crash recovery                  │
│  F-3 POLICY ENGINE: total decide(), 8 arms, default Deny, DenyIndeterminate│
│  F-4 SESSION/TASK records + checkpointing                                  │
│  F-5 EXECUTION RUNTIME: low-integrity workspace, Job Object lifecycle,     │
│      verified cancellation cascade                                         │
│  F-6 MODEL BINDING: adapter per protocol, digest pinning, cost classifier, │
│      fail-closed on unknown pricing                                        │
└───────┬───────────────┬────────────────┬───────────────┬───────────────────┘
        │               │                │               │
        v               v                v               v
   ┌─────────┐    ┌───────────┐   ┌────────────┐  ┌──────────────┐
   │ PHASE 5 │    │ PHASE 6   │   │ PHASE 7    │  │ PHASE 8      │
   │ agents  │    │ extension │   │ intelligence│ │ business     │
   │ orch.   │    │ contracts │   │ systems    │  │ intelligence │
   └────┬────┘    └─────┬─────┘   └─────┬──────┘  └──────┬───────┘
        │               │               │                │
        │  needs F-2,   │  needs F-2,   │  needs F-6,    │  needs F-2 (records),
        │  F-3, F-4,    │  F-3, F-5,    │  F-5 (isolation│  F-3+F-6 (operations),
        │  F-5, F-6     │  F-6          │  of experiments)│  P5-P7 (research)
        v               v               v                v
   ┌──────────────────────────────────────────────────────────────┐
   │ Reused across all four: task contract, grant records,        │
   │ event schema + owner, evidence/claims result schema,         │
   │ approval gates, resource budgets                             │
   └──────────────────────────────────────────────────────────────┘
```

**Reading the graph (ESR).** The four research phases do not depend on each other much; they depend on the **same six foundational capabilities**. That is the central finding of this synthesis: the apparent breadth of Phases 5–8 collapses into a small number of missing primitives, and the correct response is not to build four subsystems but to build those primitives once.

---

## 2. Dependency matrix

| Phase 5–8 subsystem | Required foundational capability | Exists? | Evidence | Blocks |
|---|---|---|---|---|
| Task lifecycle, delegation, orchestration | event log + owner, policy `decide()`, task store, session records | **No** | Phase 4 F-2.3; `SYSTEM_BOUNDARIES.md:8-20` has no events row; no code | everything in Phase 5 |
| Reviewer / independent review | second reviewer identity + result schema | **No** | `reviewer` = 0 hits in the canonical tree | Phase 5 review arm |
| Extension registry, contracts, trust tiers | Capability Registry implementation, grant records | **No** | owner row only (`SYSTEM_BOUNDARIES.md:14`); `ARCHITECTURE.md:157` claims "existing" for things that do not exist (F-1.1) | Phase 6 in full |
| Creator Mode | execution isolation that actually exists | **No** | `SECURITY_MODEL.md:42` promises containers the machine cannot run; verified alternative (low-integrity token + MIC, 9 of 11 classes contained) is unstated (F-1.1, S-1) | Phase 6 §3, Phase 7 experiments |
| Model Intelligence / Foundry | provider abstraction, cost classifier | **No** | no implementation; OD-8/OQ-1 open | Phase 5 routing, Phase 7 all |
| Evaluation Lab | pinned model bindings, fixture digests, resumable batch runner | **No** | no implementation | Phase 7 §3, Phase 8 comparables |
| Research Lab | source store with spans, citation validation | **No** | no implementation | Phase 7 §4, Phase 8 market research |
| Hardware Intelligence | timestamped resource probe | **No** (probe is trivial) | measurements exist in `.lain-audit/` only | Phase 7 §5, admission control |
| Business records (registry, actuals) | a durable typed store | **No** | SQLite is only a *Proposed* ADR (007) | Phase 8 items 1–5 |
| Business operations | approval/grant records + per-action authorization | **No** | Phase 6 §4 item 2 | Phase 8 items 6–10 |

**ESR — the honest statement.** Every one of Phases 5–8 is **blocked on the same six missing primitives**. No subsystem in the four-phase program can be honestly implemented today, and a standalone version of any of them would be a simulation of the capability rather than the capability.

---

## 3. What is implementable today

These items require **no model, no runtime, no event log owner and no approval machinery**. They are data definitions, probes, and documents — and they are not busywork, because each one is a prerequisite the later phases cannot proceed without:

| # | Item | Phase | Why it is safe now |
|---|---|---|---|
| 1 | **Typed record schemas**: evidence classes, assumptions/estimates/actuals, opportunity registry, financial records | 8 | pure data definitions; no execution |
| 2 | **Task and result schemas**: task contract with acceptance criteria; result with `claims/artifacts/evidence/checks/not_verified/indeterminate` | 5 | pure data; the interface every later phase reuses |
| 3 | **Component identity + manifest schema (self-contained, no external `$ref`)** | 6 | pure data; validation is a pure function |
| 4 | **Model record schema** with digest pinning and the five cost classes | 7 | pure data |
| 5 | **Timestamped hardware/resource probe** | 7 | read-only measurement, already prototyped in the audit |
| 6 | **Single-writer event log with one transaction per batch and redaction on write** | Foundation | the measured 963/1766 torn-read result decides it; needs only SQLite |
| 7 | **The reproducible build/check command** | Foundation | required before AT-001 means anything |
| 8 | **Phase 4 documentation corrections C-1…C-10** (with approval) | 4 | edits to false or unfalsifiable claims |

**ESR — the ordering inside this list.** Item 6 first among the code items, because every other capability records history through it; item 8 first among the documents, because C-1 and C-2 change claims that are *currently false*, and later phases inherit those claims.

---

## 4. The smallest useful vertical slice

**ESR.** The roadmap already names a first milestone, but the audit found it defined three different ways (F-5.4 / Q-3). Consolidating those and the dependency graph gives one honest slice:

> **`lain v0.1.0 — One Bounded Agent`.** A CLI program that accepts one task, runs one local model against one contained workspace through one approved tool call at a time, writes everything it does to an append-only event log, and after a hard kill can prove exactly what it did and mark anything it cannot prove as indeterminate.

Implementation order inside the slice, each step independently verifiable:

1. **Event store** — append-only SQLite, WAL, single writer, one transaction per batch, redaction on write, schema migration test, crash-recovery test. *Proof: kill mid-batch, reopen, zero torn reads; write a secret-shaped payload, confirm it never lands.*
2. **Policy engine** — total `decide()` with eight arms, default `Deny`, `DenyIndeterminate` distinct from a user's "no". *Proof: an exhaustive decision table test, plus a positive control that a permitted action is actually permitted.*
3. **Model binding** — one adapter, digest-pinned, cost classifier that fails closed on unknown pricing. *Proof: routing refuses an unknown-cost provider; a pinned digest mismatch refuses to run.*
4. **Contained execution** — low-integrity workspace, Job Object with kill-on-close, verified cancellation cascade. *Proof: the toolchain-work experiment (OQ-4) plus a zero-orphan check after cancelling a process tree.*
5. **One bounded loop** — task → model call → one tool call → event record → result, with the measured context budget enforced. *Proof: a real task completes; a task exceeding budget fails closed rather than silently truncating.*

**ESR — what makes this the right first slice.** It falsifies the architecture's riskiest assumption (a small local model driving a tool loop inside a real containment boundary) using the infrastructure every later phase needs. Phases 5–8 add capability on top of it without rework, because they reuse the same task contract, event schema, grant records and approval gates.

---

## 5. Conditions that would change this plan

| Observation | Consequence |
|---|---|
| OQ-4 shows the toolchain cannot work in a low-integrity workspace | the containment layer changes; step 4 is redesigned before steps 1–3 are relied on for *unattended* work (they remain valid for attended use) |
| The P0 spike's tool-call verdict falls below the ≥95 % reachability bar | the bounded-loop design (constrained decoding, schema repair) is revisited before step 5 is built |
| The owner chooses a different first opportunity than the Godot asset-pack experiment | Phase 8 items 1–5 still stand (they are opportunity-agnostic); only the validation content changes |
| Windows-only v0.1 is rejected (OQ-5) | the entire execution-isolation design (MIC, Job Objects, ACL derivation) is re-scoped, and step 4 becomes the critical path |

---

## 6. Open questions this synthesis adds

| # | Question |
|---|---|
| OQ-C.1 | Is the first milestone text above adopted as the single canonical milestone, replacing the three current definitions? |
| OQ-C.2 | Do items 1–5 of §3 get built *before* the event store, on the grounds that schemas are cheap and inform the store's tables — or after, on the grounds that a schema with no store is unverified? |
| OQ-C.3 | Is Phase 4's C-list applied before any implementation begins, or in parallel with the foundation work? |
