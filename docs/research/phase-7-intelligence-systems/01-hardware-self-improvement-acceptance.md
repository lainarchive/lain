# Phase 7 — Intelligence Systems: Hardware Intelligence, Controlled Self-Improvement, Acceptance, Backlog

**Status:** Research and proposal. **Nothing here is an accepted decision.**
**Base revision:** `36a3e18003ad41171be96d28cfbbda5b5304441c`
**Companion:** `00-model-evaluation-research.md` (Model Intelligence, Model Foundry, Evaluation Lab, Research Lab).
**Labels:** EUR explicit user requirement · EAD existing accepted decision · ESR evidence-supported recommendation · UAP unapproved proposal · OQ open question.

---

## 1. Hardware Intelligence

### 1.1 Purpose (ESR)

One subsystem owns the answer to "can this run *now*", and every other subsystem asks it instead of guessing. Phase 5's admission control and Phase 6's validation harness both depend on it.

### 1.2 What it measures (ESR)

| Resource | Measurement | Why it matters here |
|---|---|---|
| CPU | cores, threads, current load, per-process load | 4 cores / 4 threads, no SMT — concurrency above ~3 subprocesses degrades everything |
| RAM | total, available, committed, per-process | ~15.9 GB with ~10 GB already committed by the desktop |
| GPU / VRAM | total, used, **free**, temperature, utilization | free VRAM swings **835 MiB → 3 629 MiB**; the model that fits at idle may not fit under load |
| Disk | free space, write throughput | benchmark DBs and model artifacts are large; a full disk turns a correctness test into a failure with a misleading cause |
| Thermal/pressure | GPU temperature (measured **76–77 °C at idle**), sustained-load behaviour | thermal throttling silently changes benchmark numbers |
| Model residency | which model is loaded, at what context size, how long | swapping is expensive; the scheduler batches by model |

### 1.3 The historical-profile rule (EUR, from the program brief)

The machine profile recorded in the audit (i5-7500, RTX 3050 6 GB, 16 GB RAM, Windows 11) is **a starting reference only**. Any environment-specific recommendation must re-measure first, and the record must state when it was measured. Two reasons this is not pedantry: the audit's own numbers already disagreed with the historical profile's assumptions (no SMT; a 2.8 GB free-VRAM swing), and a stale hardware claim produces confidently wrong resource decisions.

### 1.4 Model-fit arithmetic (ESR)

A preflight check, not a heuristic: `required = weights + kv_cache(context, layers, kv_heads) + runtime_overhead`. Every term is **measured on this machine**, never estimated from a vendor table. The policy:

1. If `free_vram ≥ required × safety_factor` → load.
2. Else if another model is resident → unload, re-measure, retry **once**.
3. Else → **fail closed with the reason recorded**: report the requirement, the free amount, and what was measured. Never silently reduce context or swap to a smaller model — either changes what the result means.

### 1.5 Quantization and context cost (ESR)

Quantization level and context size are part of a model's identity for evaluation purposes, because they change both memory and quality. A result produced at Q4_K_M with a 4 096-token context is not comparable with one at Q8 with 32 768 — the record must therefore carry both, and the routing layer treats them as different *bindings* of the same model, not the same thing.

### 1.6 What Hardware Intelligence must never do

**ESR.** It must not: claim a benchmark it did not run; report a capability derived from a hardware name; kill or throttle a user process to free resources without an explicit, recorded policy decision; or present an estimate as a measurement. Where a number is derived, it is labelled derived and the derivation is stated.

---

## 2. Controlled self-improvement

### 2.1 The hard boundary (EUR)

**EUR.** *"The system must not autonomously rewrite its security policies, permissions, trust boundaries, or core governance."* This is not a caution — it is a boundary, and it must be structural: the subsystems below may **propose**, and only a human decision may **promote**.

### 2.2 The loop (ESR)

```
observe (capability records, failure taxonomy, event log)
   → identify a weak capability with evidence (a measured weakness, not an impression)
   → formulate an improvement as a falsifiable hypothesis
   → define the experiment: fixture, control, threshold, budget, stopping condition
   → run isolated (contained workspace, budgets enforced, no external effects)
   → compare against the recorded baseline (paired, same load class)
   → record the result verbatim, including failures
   → PROPOSE a reviewable change, with the evidence attached
   → human decision → promote | reject | re-test
```

**ESR — the loop is an evaluation workflow, not a mutation workflow.** Its output is a **proposal artifact** (a diff plus evidence), never a live change to prompts, policy, routing weights, or code.

### 2.3 What may be proposed, and what may not (ESR)

| May be proposed | May never be changed autonomously |
|---|---|
| Prompt/preset refinements | Security policy, permission grants, trust tiers |
| Routing weights and thresholds | The cost classifier's fail-closed rule |
| New evaluation fixtures and suites | The set of invariants (Phase 5 §8) |
| Tool/skill additions (via Phase 6 pipeline) | Approval gates and their defaults |
| Context-budget heuristics | Audit/redaction behaviour |
| Documentation corrections | Anything that changes what "verified" means |

**ESR — the asymmetry is deliberate.** Everything self-improvement may change is *performance*; everything it may not change is *authority*. Collapsing the two is how a system that improves itself becomes a system that authorizes itself — the exact failure ADR-004 exists to prevent.

### 2.4 Preserving successful findings (ESR)

A successful improvement is recorded as: the hypothesis, the experiment definition, the raw results, the baseline it beat, the promotion decision and who made it. An improvement without its baseline is an anecdote, and a promoted change whose evidence was not kept cannot be reverted with understanding — only with hope.

### 2.5 The honest limit (ESR)

On this hardware, self-improvement loops are **expensive and slow**: each iteration consumes the only model, for minutes, on 4 threads. The realistic use in v0.1 is not continuous optimization but **occasional, deliberate, bounded experiments** — for example, resolving the tool-call reliability question, or comparing two prompt shapes. Continuous self-optimization is deferred with the rest of advanced autonomy.

---

## 3. Acceptance-test plan (M/D/P tiers; positive control per denial class)

| ID | Test | Threshold | Tier |
|---|---|---|---|
| AT-7.01 | Unknown cost is not routable | 0 requests routed to a `unknown`-cost model when the $0 policy is on; denial recorded with a reason | D |
| AT-7.02 | No silent paid fallback | 0 requests fall back to a `paid`/`trial` class; paired control: a `free_local` request succeeds | D |
| AT-7.03 | Model identity is by digest | 100 % of results and routed requests record a digest; 0 records identify a model by tag alone | D |
| AT-7.04 | Result record completeness | 100 % of evaluation results carry machine, runtime, quantization, context size, fixture digest, seed, `vram_free_AT_RUN` | D |
| AT-7.05 | Fixtures are immutable within a suite version | 0 runs where the fixture digest differs between compared arms | D |
| AT-7.06 | Suites resume after interruption | a killed suite resumes with 0 duplicated and 0 lost samples | P |
| AT-7.07 | Capability claims cite measurements | 0 routing decisions that use a declared (unmeasured) value for a capability claim; declared values used only for hard filters | D |
| AT-7.08 | Model-fit check fails closed | with insufficient free VRAM, 0 loads occur, 0 context reductions, 0 silent model swaps; the reason names the requirement and the free amount | D |
| AT-7.09 | Hardware readings are timestamped | 100 % of hardware-derived recommendations carry a measurement timestamp | D |
| AT-7.10 | Citations resolve | 100 % of cited spans exist and contain the claim; any unresolvable citation fails the report | P |
| AT-7.11 | Inference is labelled | 0 sentences in a research report that are uncited **and** unlabelled as inference | P |
| AT-7.12 | Contradictions are preserved | a conflicting pair of sources produces a stated contradiction, never an averaged claim | P |
| AT-7.13 | Self-improvement cannot promote itself | 0 autonomous changes to policy, grants, trust tiers or invariants; every promotion has a human decision id | D |
| AT-7.14 | Proposals carry evidence and a baseline | 100 % of promoted changes link hypothesis → experiment → raw results → baseline | P |
| AT-7.15 | No unverified ranking | 0 published orderings of models that are not backed by a cited, versioned result set | D |

**Non-vacuity (ESR).** AT-7.01, 7.02 and 7.08 each require a paired positive control in the same run, or a router that denies everything would pass every one of them.

---

## 4. Prioritized implementation backlog

| # | Item | Depends on | Why here |
|---|---|---|---|
| 1 | **Model record schema + digest pinning + cost classifier with evidence fields** | — (pure data) | Smallest item that prevents an unbounded class of failures (unknown-cost routing, model drift) |
| 2 | **Hardware probe with timestamped readings and a recorded measurement method** | — | Blocks every resource decision; cheap; testable by inspection |
| 3 | **Model-fit preflight (fail-closed) with recorded reasons** | 1, 2 | Prevents silent degradation before any inference work exists |
| 4 | **One adapter: `openai_compatible_local` over loopback** | 1 | One adapter is enough to run everything else |
| 5 | **Evaluation result record + raw storage (content-addressed)** | 1, 2 | The evidence store; nothing measured is usable without it |
| 6 | **Tool-call conformance suite (resumable, ≥ 50 trials per shape)** | 4, 5 | The project's riskiest unknown, measured first |
| 7 | **Structured-output + failure taxonomy scorers** | 5 | Turns pass rates into actionable findings |
| 8 | **Paired-comparison runner with load-class recording** | 5, 7 | Makes comparisons legitimate on a shared machine |
| 9 | **Routing: hard filters → cost class → health → measured score** | 1, 2, 5 | Where the measurements start paying for themselves |
| 10 | **Source store with spans + citation validation pass** | 5 | Research provenance; the span must exist before synthesis |
| 11 | **Research pipeline stages (discovery → synthesis)** | 10, Phase 5 items 1–3 | Needs the task/event substrate |
| 12 | **Regression fixture capture from production findings** | 6, 7 | Converts incidents into permanent tests |
| 13 | **Coding / agent-task / retrieval suites** | 6, 8 | Broader coverage once the core measurement loop is trusted |
| 14 | **Self-improvement experiment runner + proposal artifacts** | 5, 8, 12 | Last: it consumes everything above and may change none of them |

**Sequencing rationale (ESR).** Items 1–3 are pure data and probes: they are implementable **today**, they need no model, and they remove the highest-consequence failure classes (routing to unknown-cost providers, loading a model that does not fit, comparing results that are not comparable). Items 4–5 make measurement possible. Item 6 answers the question the whole project is currently betting on. Items 7–14 are refinements that are worthless until 5 and 6 exist.

---

## 5. Dependencies and readiness

| Required foundational capability | Exists? | Evidence | Blocks |
|---|---|---|---|
| Model record / provider abstraction | **No** | Owner named at `SYSTEM_BOUNDARIES.md:16`; no contract | Items 1, 4, 9 |
| Hardware probe | **No** | No component; hardware facts live in audit notes, not in the system | Items 2, 3 |
| Evaluation result store | **No** | Owner row `:20` names the Evaluation subsystem; no schema | Items 5–8, 12–14 |
| Research source store | **No** | Owner row `:19`; roadmap Phase 4 is future work | Items 10, 11 |
| Event log (single owner, single writer) | **No** | Phase 4 F-2.3 | Everything that records anything |
| Task/agent substrate | **No** | Phase 5 §11 | Research delegation, experiment runner |

**Verdict (ESR).** Items **1, 2 and 3 are implementable now** and are the only parts of Phase 7 that are: they are data schemas, a probe, and a pure preflight function. Everything from item 4 onward needs one of the two missing foundations (an event log with an owner, or a provider abstraction). Item 6 — the tool-call conformance study — is the single highest-value measurement in the project and requires only items 4 and 5.

---

## 6. Open questions

| # | Question | Why it needs the user |
|---|---|---|
| OQ-7.1 | What is the re-check window for a `free_remote_verified` cost class (and does any remote provider remain in scope at all)? | A terms change turns a free tier into a billed one; the window is a risk decision |
| OQ-7.2 | Is retrieval in scope for v0.1 at all, given that no relevance metric exists? | Audit A-1/AT-052: retrieval quality is currently unmeasurable |
| OQ-7.3 | Minimum n and dispersion rule before a capability claim may influence routing? | Sets the evidence bar; affects how much CPU time measurement costs |
| OQ-7.4 | Which coding task set is vendored as the fixed fixture (licence and size)? | The fixture is permanent and must be redistributable |
| OQ-7.5 | Does self-improvement run at all in v0.1, or is it deferred with advanced autonomy? | Cost on this hardware is real; the value is speculative until item 6 lands |
