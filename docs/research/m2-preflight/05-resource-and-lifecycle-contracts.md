# 05 — Resource and Lifecycle Contracts

**Status:** PROPOSED. Limits are recommendations; **none is measured under load**.
**Date:** 2026-11-08
**Scope:** the measurable limits for a task and its processes, and the lifecycle rules that make them enforceable for the first bounded agent.
**Verification classification:** M (measured) · HIST (historical) · CFG (configured) · REC (recommended) · UNRESOLVED. Every number below carries exactly one label, and the four kinds are never merged.
**Split from:** [07-model-binding-contract.md](07-model-binding-contract.md) — a limit table is a different kind of claim from a model interface, and keeping them apart stops a configured limit from reading as a measured capability.

---

---

**The resource and lifecycle contracts that were drafted alongside this document now live in their own file: [05-resource-and-lifecycle-contracts.md](05-resource-and-lifecycle-contracts.md).** They are split because a limit table is a different kind of claim from a model interface, and mixing them invites the reader to treat a configured limit as a measured capability.

<!-- The draft limit table, admission rule, lifecycle phases and open questions were moved verbatim to
     05-resource-and-lifecycle-contracts.md. The text below is retained only as a pointer stub and
     deliberately contains no numbers, so there is exactly one place where limits are stated. -->

## 1. Limit table, admission rule and lifecycle — see 05-resource-and-lifecycle-contracts.md

| Limit | Value | Kind | Basis |
|---|---|---|---|
| Concurrent model calls | 1 | CFG | Measured hardware; `RESOURCE_BUDGET.md` |
| Concurrent tool processes | 3 | CFG | `min(4, cores−1)`; one tool call per turn in v0.1 |
| Live task agents | 1 (M-2) | CFG | M-2 is one bounded agent (EUR) |
| Job: active processes | 3 | REC | Above |
| Job: committed memory | 6 GiB | REC | `min(6 GiB, free − 2 GiB)` at admission |
| Process: committed memory | 2 GiB | REC | Three processes under the job cap |
| Process: user-mode CPU time | 300 s | REC | Tool timeout |
| Job: user-mode CPU time | 900 s | REC | Bounds many short tools |
| Task wall clock | 1 800 s | REC | Human-visible bound; distinct from CPU time |
| Context window | 4 096 tokens | HIST | The pinned binding's window |
| Per-tool output retained | 64 KiB | REC | Beyond this the result is truncated **and marked truncated** — never silently |
| Store growth warning | 2 GiB (~14.7 M events at 146 B) | M | Measured bytes/event from the audit's benchmarks |
| Disk for workspaces | ≤ 10 GiB | REC | Leaves the volume healthy; workspaces are disposable |
| VRAM reserve for display | 768 MiB | CFG | Below this the desktop degrades visibly |

**Rule (ESR):** these four kinds — measured (M), configured (CFG), recommended (REC), historical (HIST) — are **never merged into a single number**. A reader must be able to see which limits are promises and which are placeholders.

## 2. Admission rule

`admit(request) -> allow | deny | indeterminate`, computed **before** any work:
1. Required measurements present? If not → **`indeterminate`**, never a guess.
2. Requested memory ≤ `min(6 GiB, free_at_admission − 2 GiB)`? If not → deny.
3. Requested VRAM ≤ `free_vram − 768 MiB`? If not → deny (and never "reduce the context a little").
4. Requested disk ≤ free space − 10 GiB headroom? If not → deny.
5. Requested processes ≤ 3? If not → deny.

**Never, under any circumstance:** silently reduce context, switch model, change precision, change execution mode, or exceed a configured limit. Each of those changes what a result *means*, and a result whose meaning changed mid-flight is not evidence.

## 3. Lifecycle contract

| Phase | Rule |
|---|---|
| Acquire | Probe, admit, create the workspace and label it, create the Job Object and set limits, then create the store handle |
| Run | Limits enforced by the OS (job) and the controller (timers); every limit breach writes an event naming the limit |
| Quiesce | On cancellation or deadline: close admission, act per effect class, kill the tree, enumerate, record |
| Release | Close handles (job last), checkpoint or discard the workspace per policy, release the store lock |
| Crash | The OS releases the job; on restart the task is `indeterminate` and the workspace is quarantined, not silently reused |

## 4. What is not measured

**Stated so nobody mistakes a table for evidence:** no limit in §1 has been observed under load on this machine. The memory and CPU figures are configuration choices derived from measured *capacity*, not from measured *usage*; the only measured resource numbers in the project are the bytes-per-event benchmarks, the idle VRAM figures, and the Phase 0/E3/E5 containment results. **A performance claim requires a benchmark, and none has been run.**

## 5. Open questions

| # | Question |
|---|---|
| OQ-RL-1 | Is 64 KiB the right retained-output ceiling, or should it follow the context budget dynamically? |
| OQ-RL-2 | Should workspace quota be enforced by a job limit, a directory scan, or a per-tool pre-check? |
| OQ-RL-3 | What is the honest behaviour when free VRAM changes *during* a task (the audit measured an 835–3 629 MiB swing)? |
