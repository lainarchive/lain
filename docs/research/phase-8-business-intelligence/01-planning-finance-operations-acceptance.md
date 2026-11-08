# Phase 8 — Business Intelligence: Planning, Financial Records, Bounded Operations, Acceptance, Backlog

**Status:** Research and proposal. **Nothing here is an accepted decision.**
**Base revision:** `36a3e18003ad41171be96d28cfbbda5b5304441c`
**Companion:** `00-architecture-registry-validation.md` (architecture, Opportunity Registry, market research, validation).
**Labels:** EUR explicit user requirement · EAD existing accepted decision · ESR evidence-supported recommendation · UAP unapproved proposal · OQ open question.

---

## 1. Business planning

**ESR.** A plan is a **proposal artifact** with the same status as an architecture proposal: it states what would be done, what it is expected to cost, what it assumes, and how it would be falsified. Plans never become commitments by being written down.

Required sections: product/service definition · work breakdown with a smallest-shippable first step · cost model (typed, §2) · pricing (with observed comparables, not invented) · launch plan · marketing research (sourced) · progress tracking against the breakdown · assumptions with falsification tests · kill criteria.

**ESR — kill criteria are mandatory.** Every plan states, in advance, the observed outcome that means stop. Without it, a plan can only fail by running out of enthusiasm, which is the most expensive way to fail.

**ESR — the work breakdown must be executable as task contracts.** Business planning that produces prose rather than tasks (Phase 5 §2.1) becomes a document nobody acts on; each breakdown item should be expressible as an objective with acceptance criteria.

---

## 2. Financial records

### 2.1 Three separate typed spaces (ESR — the core rule)

```
assumptions   { assumption_id, statement, evidence_class, falsification_test, review_date }
estimates     { estimate_id, subject, basis (per-unit arithmetic or a named source), range, made_at, superseded_by }
actuals       { transaction_id, date, amount, currency, direction, counterparty, source_evidence, opportunity_id }
```

**ESR — the three never merge in storage, and any view that displays them together must label each item's type.** The consequence of merging is the classic small-project failure: an estimate becomes a remembered fact, the remembered facts sum to a projection, and the projection is treated as a result. *"Projected revenue is not earned revenue"* is the user's own rule, and typing is how it is enforced rather than remembered.

### 2.2 Record fields for actuals (ESR)

Every real money event carries: date, amount, currency, direction, counterparty, the opportunity it belongs to, and **source evidence** (a statement line, a receipt, a payout record). An actual without evidence is an estimate wearing a different label.

### 2.3 Derived views (ESR)

Budget vs actual, cost per shipped artifact, revenue by opportunity, and runway under the $0 constraint. Each derived view states: which typed spaces it used, the period, and whether any figure is an estimate. **A derived number is never stored as a fact** — it is recomputed, so it cannot drift from its inputs.

### 2.4 What is out of scope

**ESR.** Tax advice, legal structuring, invoicing compliance, and accounting-grade bookkeeping are out of scope. The system records money events and their evidence; it does not become a bookkeeping system, and it must say so rather than produce a plausible-looking financial statement.

---

## 3. Bounded business operations

### 3.1 The classification rule (ESR)

Every operation is classified by **who bears the consequence of it being wrong**:

| Class | Examples | Authorization |
|---|---|---|
| **Prepare** (internal only) | drafts, research organisation, plans, reports, task lists, prototype artifacts | allowed within budgets; no gate |
| **Present** (user-facing, no external effect) | showing a draft for approval, rendering a comparison | allowed; recorded |
| **Publish / transact** (external, third parties affected) | publishing a product or listing, contacting a customer, posting marketing content, changing an account, accepting payments or terms | **explicit human authorization per action**, never blanket, never inferred from a previous approval |
| **Commit legally or financially** | contracts, purchases, subscriptions, domain changes, publishing under the owner's name | **explicit human authorization, and the system may not initiate it** |

**ESR — the boundary is consequence, not capability.** Lain may *write* a store description; it may not *publish* it. Lain may *draft* a customer reply; it may not *send* it. This is the same structure as Phase 5's effect classes and Phase 6's grant model, applied to business actions, and it must reuse those mechanisms rather than inventing a parallel approval path.

### 3.2 What the system may never do autonomously (EUR)

**EUR.** No spending of money in any amount. No binding commitments. No publishing under the owner's name. No customer communications. No account, credential or payout changes. No ToS-violating automation, fake reviews, multi-accounting, or unauthorized access (the user's own tactics boundary: aggressive marketing and scraping public data are acceptable; fraud and platform violations are not).

**ESR — these are structural refusals, not policy defaults.** There must be no configuration flag, no "advanced mode", and no agent capability that performs them. A refusal that a manifest or a prompt can switch off is not a refusal.

### 3.3 Money-adjacent data handling (ESR)

Payment credentials, bank details and payout tokens are **never** stored in the event log, never placed in a model's context, and never handled by a generated component. The system records *that* a transaction occurred, with its evidence, and resolves credentials at the point of use through a handle (Phase 6 §2 rule 8). Append-only payloads make a leaked secret permanent (audit E-4), so the only safe design is that the value never enters the store.

---

## 4. Acceptance-test plan (M/D/P tiers; positive control per denial class)

| ID | Test | Threshold | Tier |
|---|---|---|---|
| AT-8.01 | No unsourced claim advances a stage | 0 registry records advancing with evidence class `unsupported` or `model_inference` | D |
| AT-8.02 | Projections and actuals never merge | 0 stored views or derived fields that combine `estimates` and `actuals` without per-item typing | D |
| AT-8.03 | Every actual has evidence | 100 % of `actuals` carry source evidence; a missing-evidence insert is refused | D |
| AT-8.04 | No numeric confidence field exists | 0 confidence scores in the registry schema | D |
| AT-8.05 | No autonomous spend | 0 money-moving operations without a human authorization id; paired control: an internal draft is produced without a gate | D |
| AT-8.06 | No autonomous publish/contact | 0 external publications or customer messages initiated by the system; every external action has an authorization id | D |
| AT-8.07 | Secrets never enter the store | 0 credential-shaped values in event payloads, measured by the store-level redaction filter's own counters | P |
| AT-8.08 | Kill criteria exist before work starts | 100 % of plans record at least one kill criterion at creation | D |
| AT-8.09 | Validation ladder order respected | 0 plans entering a paid rung before the preceding free rung produced a recorded result | P |
| AT-8.10 | Go/no-go includes counter-evidence | 100 % of recommendations name the strongest counter-evidence and the cheapest next test | P |
| AT-8.11 | Registry can regress | a refuted assumption moves the stage backward and the regression is retained in history | D |
| AT-8.12 | Out-of-scope is stated | the finance view reports explicitly that it is not bookkeeping or tax advice | D |

**Non-vacuity (ESR).** AT-8.01, 8.05, 8.06 and 8.07 require paired positive controls (a sourced claim *does* advance; an internal draft *is* produced; a redaction counter reports zero on clean payloads), or a system that refuses everything would pass.

---

## 5. Prioritized implementation backlog

| # | Item | Depends on | Why here |
|---|---|---|---|
| 1 | **Typed record schemas: assumptions / estimates / actuals / evidence classes** | — (pure data) | The single design decision that prevents the phase's characteristic failure; implementable today |
| 2 | **Opportunity Registry table with evidence refs and stages, including regression** | 1 | Where the work is recorded; cheap and durable |
| 3 | **Evidence store linkage (source refs + spans + retrieval date)** | Phase 7 item 10 | Business claims need the same span discipline as research |
| 4 | **Stage gates as validation functions (refuse advancement without admissible evidence)** | 1, 2, 3 | Makes the rule mechanical instead of aspirational |
| 5 | **Financial records: actuals with mandatory evidence + derived views** | 1 | Small, high-value, testable without any model |
| 6 | **Authorization records for external actions (per-action, digest-bound)** | Phase 6 item 2 (grants), Phase 5 item 9 (gates) | Reuses the existing approval machinery instead of a parallel one |
| 7 | **Market research task templates + required output shapes** | Phase 7 item 11, Phase 5 items 1–3 | Needs the research pipeline |
| 8 | **Validation experiment runner (ladder order enforced, results typed)** | 4, 7 | Where research turns into decisions |
| 9 | **Business planning artifacts with kill criteria** | 2, 8 | Plans are only meaningful after validation exists |
| 10 | **Bounded operations (drafts and organisation only)** | 6 | Deliberately last: it is the part nearest external effects |

**Sequencing rationale (ESR).** Items 1, 2 and 5 are pure data and records: they are implementable **now**, they need no model, no research pipeline and no event log owner to be *useful on paper*, and they remove the two failure modes that make a business-tracking system worse than a text file (unsourced claims, merged projections). Items 3–4 need the research substrate. Items 6–10 need the approval machinery from Phases 5 and 6 — and item 10 is last because it is the only item whose bugs have external consequences.

---

## 6. Dependencies and readiness

| Required foundational capability | Exists? | Evidence | Blocks |
|---|---|---|---|
| Typed record store (SQLite) | **No** | No implementation exists; SQLite+FTS5 is a *Proposed* ADR (007) | Items 1, 2, 5 |
| Event log (single owner, single writer) | **No** | Phase 4 F-2.3 | Anything recorded as history |
| Research source store with spans | **No** | Phase 7 §5 | Items 3, 7 |
| Approval/grant records | **No** | Phase 6 §4 item 2 | Items 6, 10 |
| Task/agent substrate | **No** | Phase 5 §11 | Items 7, 8 |

**Verdict (ESR).** Phase 8's *records* (the typed schemas, the registry, the actuals table with mandatory evidence) are the most independently implementable artifacts in the entire four-phase program, because they are data definitions that need no model and no runtime. Its *operations* (items 6–10) depend on approval machinery that does not exist and must not be improvised. The honest statement is therefore: **the registry and the financial records can be built first and used immediately; the automation cannot be built until Phases 5 and 6 provide the gates.**

---

## 7. Open questions

| # | Question | Why it needs the user |
|---|---|---|
| OQ-8.1 | Which single opportunity is validated first, and is the Godot asset-pack experiment the chosen rung-3 artifact? | This is the user's strategic decision, and the whole phase is sequencing around it |
| OQ-8.2 | Is any paid tooling permitted for validation (e.g. a store listing fee), or is the $0 rule absolute through stage 5? | The standing $0 rule says no without an explicit yes |
| OQ-8.3 | What constitutes "publishing under the owner's name" for a store listing (account ownership, branding, contact details)? | Legal/identity boundary the system cannot decide |
| OQ-8.4 | Does the income objective enter `VISION.md` as an explicit long-term goal, or stay out of the canonical repository? | Phase 4 F-4.3 and OQ-7; affects whether this phase has a canonical mandate |
| OQ-8.5 | How much owner time per week is available for validation, as a budget the planner can respect? | Without a real budget, the work breakdown is fiction |
