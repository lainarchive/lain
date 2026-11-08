# Phase 5 — Agents and Orchestration

**Status:** Research and proposal. Nothing in this directory is an accepted decision, and no canonical document was modified.
**Base revision:** `36a3e18003ad41171be96d28cfbbda5b5304441c`
**Date:** 2026-11-08

## Documents

| File | Contents | Status |
|---|---|---|
| `README.md` | This index, plus the phase's headline conclusions and blockers. | Complete |
| `00-agents-orchestration-specification.md` | Agent architecture, delegation and task contract, scheduling and resource management, communication protocol, bounded autonomy, failure and recovery, security requirements, invariants, acceptance tests, prioritized backlog, dependency analysis, open questions. | Complete |

## Required deliverables → where they are

| Required deliverable | Section |
|---|---|
| Agent architecture specification | §1 |
| Orchestration architecture | §2, §8 |
| Delegation and task contract | §2.1, §2.2 |
| Agent lifecycle model | §1.4 |
| Scheduling and resource-management design | §3 |
| Agent communication protocol | §4 |
| Failure and recovery strategy | §6 |
| Security and permission requirements | §7 |
| Acceptance-test plan | §9 |
| Prioritized implementation backlog | §10 |

## Headline conclusions

1. **Four agent types, not eleven.** The brief's eleven candidate kinds mix lifecycle, job title and authority. A separate *type* is justified only by a difference in lifecycle, authority, or context; everything else is a preset. Background work is a **tool with a job record**, not an agent.
2. **On this hardware, multi-agent ≠ multi-model-in-parallel.** One model call in flight; concurrency is for tools, I/O and human time. Recommended ceilings: 1 model call, 3 tool subprocesses, 4 live task agents, delegation depth 2.
3. **The task contract is the system's central interface.** It must be complete enough that an agent needs no conversation history to start, and it may not be admitted without checkable acceptance criteria.
4. **Capabilities are granted at admission and are immutable for the instance.** Widening requires a new admission decision. This is ADR-004 made structural rather than advisory.
5. **Claims are not evidence; evidence is.** The result schema mandates `not_verified[]` and `indeterminate[]`, which is what converts "the model said it worked" into "the log says it happened".
6. **Cancellation is a verified cascade**, not a flag: the whole process tree, then a zero-orphan check. (Audit defect S-5.)
7. **Absence of approval is denial**, and a timeout is `DenyIndeterminate` — distinct from a user's "no", and never retryable.
8. **Agent-to-agent content is untrusted input.** Multi-agent design inherits the prompt-injection problem across agents, not just from the web.
9. **Recovery is evidence-based:** on restart, every effect that cannot be proven from the log is marked *indeterminate* and surfaced — never silently re-run.
10. **Two invariants carry most of the safety:** no task completes with an open rejection (I-2), and no task waits on a resource without a timeout (I-6).

## Blockers

The phase **cannot be implemented today**, and no honest standalone version of it can be built either. The blocking foundation, with evidence:

| Missing capability | Evidence |
|---|---|
| Event log owner + single-writer rule | `SYSTEM_BOUNDARIES.md:8-20` — 11 owner rows, none for events; "single writer" 0 hits in the canonical tree (Phase 4 F-2.3) |
| Policy Engine `decide()` contract | Named as an owner at `SYSTEM_BOUNDARIES.md:13`; contract defined nowhere |
| Task Manager schema | Named at `SYSTEM_BOUNDARIES.md:11`; no schema |
| Execution Runtime (workspace, containment, process control) | Named at `:15`; containment verified only as a mechanism experiment, and the "does legitimate toolchain work run inside it" question (S-3) is unanswered |
| Model provider abstraction | Named at `:16`; language/toolchain decision open — `DECISIONS.md` ADR-011 is "Experiment required", `cargo`/`rustc` are not installed, `node` v24.21.0 and `Python 3.15.0` are |

**Smallest useful vertical slice that is not blocked:** (1) task-contract and result schemas, (2) the single-writer event log with one transaction per batch, (3) the admission-control budget calculator as a pure function. All three are independently testable, and they unblock Phases 6–8.

## Open questions

See `00-agents-orchestration-specification.md` §12: five questions, of which the load-bearing one is whether a second resident model is permitted for independent review (VRAM-dependent).
