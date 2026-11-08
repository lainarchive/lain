# Phase 8 — Business Intelligence: Architecture, Opportunity Registry, Research and Validation

**Status:** Research and proposal. **Nothing here is an accepted decision.**
**Base revision:** `36a3e18003ad41171be96d28cfbbda5b5304441c`
**Companion:** `01-planning-finance-operations-acceptance.md` (planning, financial records, bounded operations, acceptance tests, backlog, readiness).
**Labels:** EUR explicit user requirement · EAD existing accepted decision · ESR evidence-supported recommendation · UAP unapproved proposal · OQ open question.

---

## 0. Scope, and the failure mode this phase exists to avoid

**EUR.** Lain should eventually *"help generate income to fund the user's other projects"*, the user has said (*"I want to give the money-making aspect considerably more attention than I did previously… I don't want us building an elaborate AI ecosystem for six months before discovering we have no practical way to monetize it"*), and the program brief states the goal precisely: *"a research-driven, user-controlled business intelligence environment"*, **not** *"an unrestricted autonomous business operator"*.

**The failure mode (ESR).** A language model asked about markets produces fluent, confident, uncited market claims. In an income context those claims lead to building the wrong thing, which is the most expensive error available: it consumes the same hours that would have produced revenue. Therefore the single most important design property of this phase is that **a business claim cannot enter the system without a source, and a projected number cannot enter it without being labelled a projection.**

Two rules carry that property, and everything else in this phase is scaffolding around them:

1. **Provenance or it does not exist.** Every fact in the registry, every market claim, every competitor observation carries a source and a retrieval date.
2. **Assumptions are never displayed as records.** Projected revenue, estimated demand, and assumed costs live in a separate typed space from actual transactions, and no view merges them without the distinction being visible.

**What this phase must not do (ESR).** It must not: spend money; make binding commitments; contact customers; publish anything; claim demand without evidence; present a projection as a result; or let a model's confidence substitute for a source. Each of these is enforced structurally (§3, and Phase 8 companion §3), not by instruction to a model.

---

## 1. Subsystem map

```
                 ┌──────────────────────────────┐
                 │  Opportunity Registry        │  durable: ideas, evidence, stage, next action
                 └──────────────┬───────────────┘
                                │ (feeds research objectives)
                 ┌──────────────v───────────────┐
                 │  Market Research             │  Phase 7 Research Lab + source store (spans, dates)
                 └──────────────┬───────────────┘
                                │ (evidence, contradictions preserved)
                 ┌──────────────v───────────────┐
                 │  Validation Workflows        │  cheapest falsifying experiment first
                 └──────────────┬───────────────┘
                                │ (results: verified | refuted | inconclusive)
                 ┌──────────────v───────────────┐
                 │  Business Planning           │  work breakdown, pricing, cost model, launch plan
                 └──────────────┬───────────────┘
                                │ (plans are proposals; external actions need approval)
                 ┌──────────────v───────────────┐
                 │  Bounded Operations          │  drafts and organisation only
                 └──────────────┬───────────────┘
                                │ (records actual money events only)
                 ┌──────────────v───────────────┐
                 │  Financial Records           │  actual vs estimated, never merged
                 └──────────────────────────────┘
```

**ESR — the dependency direction is one-way.** Validation results *revise* the registry; the registry never revises validation results. This is the mechanism that prevents the common failure where accumulated enthusiasm in a tracking system becomes its own evidence.

---

## 2. Opportunity Registry

### 2.1 Record (ESR)

```
opportunity_id          stable
title, one_line         the idea in one sentence
problem                 whose problem, stated as an observable
target_customer         who specifically (not "developers")
proposed_solution       what would be built or offered
revenue_model           how money would arrive (stated, not assumed)
alternatives            what the customer does today instead   <-- mandatory field
competitors[]           with source refs
costs[]                 estimated vs actual, typed separately (§ companion)
evidence[]              source refs + spans + retrieval date + how it bears on the claim
assumptions[]           explicit, each with a falsification test
validation_stage        see §2.2
confidence              evidence class (§2.3), NOT a number
risks[]                 what would make this fail
next_action             one concrete step, with an owner and a date
status                  exploring | validating | building | parked | rejected
```

**ESR — `alternatives` is mandatory.** The most common way a small product fails is not competition but the customer's existing behaviour: doing nothing, using a spreadsheet, or using a free tool that is "good enough". A registry that cannot name the status-quo alternative has not understood the problem.

### 2.2 Validation stages (ESR — each stage requires evidence, not optimism)

| Stage | Gate to enter | What it means |
|---|---|---|
| 0 — Observed | a stated problem, sourced (a forum thread, a review, a request) | someone is unhappy about something |
| 1 — Problem validated | ≥ 3 independent sources describing the same problem in their own words, spans stored | the problem is real and recurring |
| 2 — Solution tested | a concrete artifact exists and was used by at least one person who is not the owner | the solution addresses the problem |
| 3 — Willingness signalled | a non-binding signal (a download, a waitlist entry, a direct request) — recorded verbatim | interest, not money |
| 4 — Revenue evidenced | an actual transaction recorded in actuals | the only stage that means income |

**ESR — stages may be skipped forward only with evidence, and stages may be moved backward freely.** A registry that cannot regress accumulates zombies: projects that "seem promising" forever because nothing is allowed to contradict them.

### 2.3 Evidence classes, not confidence scores (ESR)

| Class | Meaning |
|---|---|
| `primary_user_statement` | the user's own words, recorded verbatim with a source |
| `observed_behaviour` | what people measurably did (downloads, issues, purchases) with the source |
| `third_party_report` | someone else's analysis, with its own provenance and date |
| `model_inference` | **an inference by a model, never admissible as evidence for a market claim** |
| `owner_assumption` | an assumption by the user, recorded as an assumption and given a falsification test |
| `unsupported` | no source; may be stored, may never advance a stage or justify a plan |

**ESR — no numeric confidence field.** A 0–1 confidence score invented by a model is precisely the class of unsupported precision the audit removed elsewhere (Phase 4 §Q). The evidence class says what kind of thing is known; that is more decision-relevant and impossible to inflate.

---

## 3. Market research and opportunity validation

### 3.1 Market research (ESR)

Executed as Research Lab work (Phase 7 §4) with additional rules specific to business claims, because business claims are unusually prone to unsupported consensus:

| Question | Required output shape |
|---|---|
| Is there demand? | Observed behaviour with sources and dates (search volume where a source exists, community requests, issue trackers, store reviews), or an explicit "no evidence found, searched X, Y, Z" |
| Who is the customer? | A specific describable population; "small studios using Godot and shipping to Steam" is acceptable, "indie devs" is not |
| What do they do today? | Named alternatives, including doing nothing |
| What would it cost them to switch? | Time, learning, migration, trust |
| What do comparable things cost? | Observed prices with sources and dates, **not** a suggested price |
| What is the competitive gap? | A gap backed by an observed complaint, not by a feature comparison |
| What are the risks? | Including platform risk (store policy, licence terms, API changes) |

**ESR — the platform-risk row exists because the $0 constraint makes it load-bearing.** Selling into a platform whose terms can change unilaterally is a different risk from competing on quality, and it is not discoverable from a feature comparison.

### 3.2 Validation workflow (ESR — cheapest falsifying experiment first)

The ladder below is ordered by cost, and the rule is that **a stage may not be skipped because the cheaper test feels unnecessary**:

| # | Experiment | Cost | Falsifies |
|---|---|---|---|
| 1 | Source review against stage-1 gate (≥ 3 independent sources) | minutes | "nobody actually has this problem" |
| 2 | Write the artifact-request or landing copy and measure comprehension with 3–5 target users | hours | "nobody wants it described this way" |
| 3 | Build the smallest useful artifact (for asset packs: one pack, not a pipeline) | days | "the thing cannot be built well enough to sell" |
| 4 | Publish it free and observe downloads/installs/issues | days | "nobody wants it even for free" |
| 5 | Ask for money at a low price point and observe conversion | days | "free interest ≠ willingness to pay" |
| 6 | Only then invest in expansion | weeks | — |

**ESR — for this project the concrete stage-3–5 instance is a Godot asset pack**, because the user already has Godot experience, the platform is free to publish into, and the artifact is small enough to be a real test rather than a project. This is a **candidate experiment, not a revenue forecast**: the audit explicitly declined to invent a revenue number, and so does this document. What can be stated is the *decision structure*: build one pack, publish it, and let the observed behaviour decide the next step.

**ESR — prefer $0 validation.** Every rung above is at $0 except the value of the owner's time. Any validation that requires spending money must be the user's decision, per the standing rules.

### 3.3 Go / no-go (ESR)

A go/no-go recommendation must state: the stage, the evidence for it, the strongest counter-evidence found, what would change the answer, and the cheapest next test. A recommendation without counter-evidence is advocacy, and the system must be able to produce "no-go" as a normal outcome — a validation system that has never recommended parking an idea is not validating anything.
