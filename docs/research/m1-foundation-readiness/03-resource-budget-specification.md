# 03 — Proposed `RESOURCE_BUDGET.md` Specification

**Status:** Proposed content for a file that does not yet exist (`RESOURCE_BUDGET.md` is a Phase 4 finding C-8; creating it is **not** authorized yet and was **not** done).
**Base revision:** `36a3e18003ad41171be96d28cfbbda5b5304441c`
**Labels:** EUR · EAD · ESR · UAP · OQ · **M** measured on this machine · **D** derived from a measurement by a stated rule · **P** proposed, no measurement yet.

**Purpose (EUR).** `ACCEPTANCE_TESTS.md` AT-065 cites "documented limits" that are documented nowhere, and the audit's numeric results live only in `.lain-audit/`. This file is where those numbers belong so that tests **cite** them instead of hard-coding them.

**Governing rule (ESR).** A **P** entry is a placeholder, not a finding. It may not gate a release until replaced by an **M**-tier measurement, and it must carry the procedure that would replace it.

---

## 1. Hardware measurements (historical **M**, requiring revalidation)

| Resource | Value | Source | Revalidation |
|---|---|---|---|
| CPU | Intel i5-7500, **4 cores / 4 logical (no SMT)** | HIST `20-p0-preparation.md` §6; re-measured SESS | cheap: `Get-CimInstance Win32_Processor` |
| RAM | 16 GB class; **~15.9 GiB** visible | HIST; re-measured SESS | as above |
| GPU | NVIDIA RTX 3050, **6 144 MiB VRAM** | HIST; re-measured SESS | `nvidia-smi` |
| GPU idle use | **818–835 MiB, 0 %, 76–77 °C at idle** | HIST | `nvidia-smi` |
| Free VRAM range observed | **835 MiB → 3 629 MiB** across sessions (a 2.8 GB swing outside Lain's control) | HIST (audit G-4) | sample before each model load |
| OS | Windows 11 Pro; user token **Medium** integrity, UAC-filtered; `SeImpersonatePrivilege` and `SeIncreaseQuotaPrivilege` **absent**; Developer Mode ON | HIST §6 | `whoami /priv` |
| Storage | C: ~113.5 GB free at audit time; D: 0.4 GB unusable stub | HIST | `Get-PSDrive` |
| Toolchain present | `node v24.21.0`, `Python 3.15.0`, `git 2.56.0.windows.2`, ollama client 0.40.4 (no daemon listening); **`cargo`/`rustc` absent** | SESS | re-probe at session start |

**ESR.** These are *environment details*, not a specification. Every environment-specific recommendation elsewhere in the research must re-measure and **timestamp** rather than inherit these values (Phase 7 §5 rule).

## 2. Workload measurements (**M**, HIST)

| Workload | Measured | Source |
|---|---|---|
| Event storage, WAL, one transaction per batch, 100 000 rows | **146 B/event** (`bench_batch_100000_wal_NORMAL.db` = 14 581 760 B) | HIST §4 E-3 |
| Event storage, per-document commits | 146 B/event at 100 000 rows (`bench_txn_100000`), 143 B/event at 20 000, 147 B/event at 2 000 | HIST |
| Torn reads, batch commits | **0 / 1 212** observations | HIST |
| Torn reads, per-document commits | **963 / 1 766** observations (~55 %) | HIST |
| Context cost, system prompt + 3 tool schemas + task | **396 tokens** (= 9.7 % of a 4 096-token window) | HIST (audit G-5) |
| Context cost with one tool result | **618 tokens** (15.1 % of a 4 096-token window) | HIST |
| Desktop framework peak memory (not chosen for v0.1) | Tauri 336 MB, Electron 543 MB | HIST (audit OD-4) |
| Audit-tree storage shape (context for storage budgeting) | 142 files / 149 514 684 B, of which 99.6 % is SQLite benchmark databases | HIST |

## 3. Configured limits (user-owned; **ESR** defaults)

These are the values a user may set, and which Lain **must not** silently exceed:

| Limit | Recommended default | Rationale |
|---|---|---|
| `max_concurrent_model_calls` (local) | **1** | one resident model fits VRAM (**M**: ~5.3 GiB free observed); two would swap |
| `max_tool_subprocesses` | **3** = `min(4, cores − 1)` (**D**) | reserve one core so cancellation and the UI stay responsive; **this is a design rule, not a measurement** (Phase 4 §F-M1-3) |
| `max_live_task_agents` | **4** | bounded by tool concurrency; more only queue |
| `max_delegation_depth` | **2** | prevents fan-out explosion; Phase 5 §2 |
| `max_resident_models` | **1** | VRAM |
| `max_background_jobs` | **1** | single-user machine; background work must not starve interaction |
| `event_store_soft_size` | **2 GiB** (**D**: 146 B/event ⇒ ~14.7 M events) | triggers a warning, not a deletion |
| `context_window_default` | **4 096 tokens** (the pinned model's window) | below this the audit's measured 396-token fixed cost dominates |
| `context_reserve_for_tools` | **≥ 1 024 tokens** (**D**) | one tool result measured at 618 tokens with 3 schemas at 396 total ⇒ reserve headroom rather than truncate silently |

## 4. Recommended defaults that are not limits (**ESR**)

- Warn (do not fail) when free VRAM at admission is below the model's measured requirement × 1.25.
- Unload a model after **5 minutes** idle (**P**) — replace with a measurement of reload cost vs held VRAM.
- Refuse to start a second *writer* to the event store under all configurations (not a tunable).
- Treat `%TEMP%` growth by contained processes as unbounded unless a quota is set — a known gap (`02-security-and-containment.md` §3.2 item 4).

## 5. Unverified estimates (**P** — must be replaced before they gate anything)

| Estimate | Value now | Procedure to replace it |
|---|---|---|
| Events per interactive session | ~200 | count events in the first week of real use |
| Startup time budget | < 500 ms | measure cold start on this machine |
| Event append latency (batch of 1) | < 5 ms | measure with 10 000 appends, report p50/p95/max |
| Model load time | 3–10 s | measure per pinned binding, record digest |
| Tokens/second for the pinned model | unknown | measure with the Evaluation Lab harness once it exists |
| FTS5 storage multiplier | unknown (not in the 146 B baseline) | measurement **P-2**, below |

## 6. Measurements that must be taken (procedure and required output)

| # | Measurement | Procedure | Required output |
|---|---|---|---|
| P-1 | Hardware revalidation | one script: CPU cores, RAM, VRAM total/free, disk free, OS build, token integrity, toolchain versions | timestamped record written **into the event store** as `host.probed` |
| P-2 | Store growth with FTS5 | insert 100 000 representative events with FTS5 on, record file size | B/event with FTS5, compared against 146 B/event without |
| P-3 | Append latency | 10 000 single-event batches and 10 000 100-event batches | p50/p95/max ms per batch, per size class |
| P-4 | Crash-recovery time | kill at controlled points, measure open-to-ready | seconds, and torn rows (must be 0) |
| P-5 | Toolchain-in-Low-workspace (**OQ-M1.3**) | run `git status`, `git add`, `node -e`, `python -c` inside a Low-labelled workspace, capture ALLOW/DENY per operation | a table of operation → outcome → mechanism, with at least one **positive control** per denial class |
| P-6 | Context budget with real tasks | run 20 real one-tool tasks, record tokens per component | token histogram + the truncation events (must be 0) |

**ESR — P-5 is the highest-value measurement in the package.** It decides whether MIC is the containment layer or only a hardening layer, and every later execution decision depends on it.

## 7. Resource discovery, and the no-silent-violation rule (ESR)

1. **Probe at session start** (P-1), write a `host.probed` event, and use the fresh values — never the historical table above.
2. **Compute the admission budget** from the probe and the configured limits: `free_vram_now`, `free_ram_now`, `cores`, `disk_free`.
3. **Refuse, do not adapt silently.** If a requested model or job exceeds the budget, the answer is a refusal with a recorded reason — **never** a smaller context, a different model, or a swap that changes what a result means (Phase 7 §5).
4. **Adapt only within configured limits**, and record every adaptation as an event (`budget.adapted` with before/after and reason).
5. **User-configured limits are inviolable.** Lain may refuse to exceed them; it may never exceed them because a task looks important.
6. **Report drift.** If the probe differs from the historical table by more than 20 %, record it explicitly — the audit's own GPU figure moved 2.8 GB between sessions, so drift is expected, not exceptional.

## 8. Open questions

| # | Question |
|---|---|
| OQ-M1.12 | Are the §3 defaults accepted as the initial configured limits, or should they be set lower until P-3/P-4 produce real numbers? |
| OQ-M1.13 | Is the event store allowed to grow unbounded until `event_store_soft_size` is reached, or is a compaction policy required in v0.1? (couples to OQ-M1.7) |
| OQ-M1.14 | Is a `%TEMP%` quota for contained processes required before any tool execution runs contained? |
