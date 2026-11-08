# RESOURCE_BUDGET

**Status:** proposed specification with current measurements. The **probe and
admission layer are not implemented yet** (M-1 Step 3); this document is the
specification they will implement, and every number is labelled with how it was
obtained.

**Measurement convention.** Every measurement carries four things: the value, the
method, the time it was taken, and the machine it was taken on. A value copied
from an earlier session is marked `HIST` and **must be re-measured before it is
used to make a decision** — hardware state, free memory and free VRAM all move
while the machine is in use.

**Labels used below**

| Label | Meaning |
| --- | --- |
| **M** | Measured here and now, on this machine. |
| **HIST** | Measured on this machine in an earlier session; a reference, not a current fact. |
| **CFG** | Configured limit: a number this project chooses to enforce. |
| **REC** | Recommended default: a starting value derived from a measurement by a stated rule. |
| **EST** | Estimate with no measurement behind it. Must not gate anything. |

**The rule that governs this whole file:** measurements, configured limits,
recommendations and estimates are never merged into a single number. A report
that says "Lain uses 4 GB" without saying which of the four it means is not a
budget, it is a guess with a decimal point.

## 1. Hardware measurements

| Resource | Value | Label | Method | When |
| --- | --- | --- | --- | --- |
| CPU | Intel Core i5-7500 @ 3.40 GHz, **4 physical cores, 4 logical, no SMT** | **M** | `os.cpus()` in Node 24.21.0 | 2026-11-08 |
| Memory total | **15.88 GiB** | **M** | `os.totalmem()` | 2026-11-08 |
| Memory free | **7.99 GiB** | **M** | `os.freemem()` | 2026-11-08 |
| Disk, C: | **73.19 GiB free** of 928.90 GiB | **M** | `Get-PSDrive C` | 2026-11-08 |
| Disk, D: | 0.38 GiB free — unusable as a workspace | **M** | `Get-PSDrive D` | 2026-11-08 |
| GPU | NVIDIA GeForce RTX 3050, **6144 MiB total** | **M** | `nvidia-smi --query-gpu` | 2026-11-08 |
| GPU memory free | **5389 MiB**, 614 MiB in use, 5 % utilisation, 77 °C | **M** | `nvidia-smi` | 2026-11-08 |
| GPU tooling | `nvidia-smi` present; **`ollama` client 0.40.4 present, daemon not listening** on `127.0.0.1:11434` | **M** | `nvidia-smi`, `ollama --version`, HTTP probe | 2026-11-08 |
| OS | Windows 11 (`Microsoft Windows NT 10.0.26200`), x64 | **M** | `os.type()`, `os.release()` | 2026-11-08 |

**Historical comparison (HIST).** An earlier session on the same machine recorded
free VRAM swinging between **835 MiB and 3629 MiB** — a 2.8 GB range outside this
project's control, driven by the desktop, browser and other applications. That
range, not the 6144 MiB headline figure, is why model fitting must measure at the
moment of load rather than trusting a table.

**What could not be measured.** Available memory that accounts for the page file,
committed memory per process, and per-process GPU attribution are not obtainable
here without additional tooling. They are recorded as unavailable rather than
estimated.

## 2. Workload measurements

Only three workload numbers have been measured in this project's history, and all
three are **HIST**:

| Workload | Value | Label | Source |
| --- | --- | --- | --- |
| Event storage cost (batched, WAL, 100 000 rows) | **146 B/row** | HIST | `.lain-audit` benchmark databases |
| Event storage cost (per-row commit, 20 000 rows) | 143 B/row | HIST | same |
| Event storage cost (per-row commit, 2 000 rows) | 147 B/row | HIST | same |
| Torn-read rate, commits per document | **963 torn reads in 1 766 observations** | HIST | `.lain-audit/20-p0-preparation.md` |
| Torn-read rate, one transaction per batch | **0 torn reads in 1 212 observations** | HIST | same |
| Prompt cost, system + 3 tool schemas | **396 tokens** | HIST | `.lain-audit/13-documentation-reconciliation.md` |
| Prompt cost, with one tool result | 618 tokens (15.1 % of a 4096 window) | HIST | same |

**No measurement exists** for: model load time, tokens per second, tool-call
conformance rate of a small model, peak RSS of any Lain process, or the CPU cost
of prompt evaluation. Those are the numbers Step 3's probe and the M-2 evaluation
work exist to produce; nothing in this repository may assume them.

## 3. Configured limits (CFG)

These are limits this project chooses to enforce. They are deliberately
conservative on a 4-core, 16 GiB machine, and every one of them is a
configuration value that can be raised with evidence.

| Limit | Value | Rationale |
| --- | --- | --- |
| Concurrent model calls | **1** | A single 6 GiB GPU cannot hold two useful models; concurrent calls also double peak memory with no throughput gain on 4 cores. |
| Concurrent tool subprocesses | **`min(4, cores − 1)` = 3** | Leaves one core for the supervisor, which must stay responsive to enforce cancellation and to record events. |
| Live task agents | **4** | Two per available core minus the supervisor; beyond this, queueing is cheaper than context switching. |
| Delegation depth | **2** | Depth 3 has no use case in v0.1 and multiplies the number of live agents. |
| Event store growth warning | **2 GiB** | At 146 B/event that is ≈ 14.7 M events; the warning exists so storage exhaustion is planned for rather than discovered. |
| Event store retention | **none by default** | The store's value is that it can prove what happened. Deletion is an explicit, recorded action. |
| Workspace scratch quota | **not yet set** | Must be set before any contained process runs, or containment has an unbounded writable region. See `open-issues.md`. |
| Model context window | **4096 tokens** for the v0.1 binding | See the HIST measurement in §2: 396 tokens is fixed overhead. A larger window is a different binding and must be evaluated as one. |

## 4. Recommended defaults (REC)

| Recommendation | Value | Rule it follows |
| --- | --- | --- |
| Reserve for the OS and desktop | **4 GiB** of the 15.88 GiB total | REC: leave at least 25 % of physical memory outside any workload. The desktop was holding ~5 GiB of it when measured. |
| Lain's memory ceiling | **min(6 GiB, free at admission − 2 GiB)** | REC: never allocate more than a third of physical memory, and never leave less than 2 GiB of headroom for the toolchain. |
| Model weight budget | **free VRAM − 768 MiB** | REC: 768 MiB covers the runtime's own overhead and the desktop's GPU use, which was 614 MiB when measured. |
| Disk for the event store | **≤ 10 GiB** before the growth warning is escalated | REC: C: has 73 GiB free; an unbounded log on a system drive is a predictable failure. |

## 5. Unverified estimates (EST)

There are deliberately **no estimates in this document**. Anything that would be
an estimate here — model quality, tool-call reliability, end-to-end latency — is
instead listed in §2 as "not measured", because an estimate that looks like a
measurement is how a project starts believing a number nobody took.

## 6. How resources are discovered and how admission works

**Specification for Step 3** (not implemented):

1. **Probe** — a single command (`npm run probe`) collects exactly the fields in
   §1, plus the workspace volume's free space, and prints versioned JSON. GPU
   data is best-effort: when `nvidia-smi` is absent or fails, the field is
   `unavailable` with a reason, never a guess and never zero.
2. **Classify** — every field is emitted with its label (`measured`,
   `unavailable`) so a consumer cannot mistake absence for zero.
3. **Admit** — admission compares a request
   (`{model_bytes, context_tokens, tool_slots, agent_slots, disk_bytes}`) against
   the configured limits and the freshly measured free resources. Three outcomes:
   `allow`, `deny` (with the rule that refused it), `indeterminate` (a required
   measurement is unavailable).
4. **Never adapt silently.** Admission never reduces a context window, substitutes
   a smaller model, lowers precision, or changes an execution mode to make a
   request fit. Each of those changes what a result means, so each one requires a
   new decision — and the refusal is recorded with its reason.
5. **Independent of the model.** Admission is deterministic code. A model cannot
   argue its way past a limit, and no model output is an input to the check.
6. **Profiles** — three named profiles ship as configuration, not as code paths:
   `minimal` (one agent, no background work, model loaded on demand),
   `development` (the §3 limits), `workload` (limits raised deliberately, with the
   raised values recorded in the run). The historical i5-7500/RTX 3050 profile is
   the default *because it was measured here*, not as a universal target: on any
   other machine the probe's measurements govern and the defaults only apply where
   a measurement is missing.
