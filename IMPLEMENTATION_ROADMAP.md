# Implementation Roadmap

**Version:** 0.1 | **Status:** Proposed sequencing, not calendar promises.

## Delivery rules
1. Build and verify one vertical slice at a time.
2. Establish contracts and policy before autonomous capabilities.
3. Keep the first implementation modular and local.
4. Add infrastructure only when a demonstrated need exists.
5. Every phase ends with acceptance evidence.
6. Lain starts clean in this repository. DSH and prior projects are research references, not source to import.

## Phase 0: Repository foundation
Deliver repository conventions, architecture records, threat model, toolchain decision, build/test baseline, config conventions, and minimal executable.
**Exit:** clean checkout builds; format/lint/tests run reproducibly; no secrets committed; platform support documented.

## Phase 1: Core foundation
Deliver Core runtime, command/query boundary, configuration, structured logging, event envelope, durable sessions, graceful shutdown.
**Exit:** create/read a session, append events, restart, and recover state with schema migration tests.

## Phase 2: First model-backed agent
Deliver one provider adapter, normalized model interface, basic routing policy, one agent loop, small native tool registry, CLI.
**Exit:** bounded task completes; model selection and tool activity are inspectable; timeouts and permissions are enforced.

## Phase 3: Reliable task execution
Deliver task records, dependencies, workspaces, cancellation, checkpoints, bounded retries, resource/time limits, recovery.
**Exit:** interrupt, restart, inspect, and resume or safely fail without duplicated side effects.

## Phase 4: Memory and knowledge
Deliver memory records, provenance, classification, duplicate/conflict handling, lexical retrieval, entity/relationship records, graph queries.
**Exit:** retrieve with source and timestamp; correct/supersede; answer provenance queries; untrusted content is not promoted to trusted memory.

## Phase 5: Agent orchestration
Deliver reusable specialists, shallow delegation, scheduler, context packaging, inspection, independent verification hooks.
**Exit:** bounded multi-agent task runs with explicit permissions and resource limits and produces verifiable deliverables.

## Phase 6: Extensibility
Deliver skill format, plugin manifest/validation, MCP integration, capability permissions, lifecycle management, Creator Engine candidate workflow.
**Exit:** create and validate an extension in isolation; inspect permissions; require approval before activation; revoke cleanly.

## Phase 7: Intelligence systems
Deliver model registry, evaluation harness, research records, hardware inspection, inference-engine adapters, experiment registry.
**Exit:** compare candidates with reproducible tasks and measured resource data; preserve provenance; roll back experiments safely.

## Phase 8: Business intelligence
Deliver opportunity records, market research, validation evidence, planning, basic financial analytics, bounded operations.
**Exit:** sourced opportunity assessment includes assumptions, costs, risks, validation plan, and human approval boundaries. No autonomous financial commitments.

## Phase 9: Interface expansion
Deliver advanced TUI, desktop proof of concept, execution monitor, agent/task workspace, graph explorer, interface extension system.
**Exit:** multiple clients observe shared Core state; accessible interaction paths exist; desktop choice is evidence-based.

## Cross-cutting gates
Security, cost, privacy, reliability, quality, and provenance are mandatory throughout. Unknown pricing is not free; fallbacks cannot weaken policy; secrets are not ordinary memory; important claims and decisions trace to evidence.

## Explicitly deferred
Full swarms, advanced GraphRAG, dedicated graph databases, model training, broad plugin marketplace, mobile, remote multi-user hosting, unattended external operations, and production self-modification.

## Reconciliation: future integration work

Future integration work, without changing the existing foundation milestone:
- Orchestration: collaboration records, independent review, dispute escalation, and bounded blocker handling.
- Extensibility: Mods integrated through the existing extension contracts, registry, isolation, and lifecycle.
- Intelligence and evaluation: capability effectiveness and artifact-quality evaluation shared across engineering, Creator Engine, and Labs.

## Milestone status

| Milestone | Status | Started | Notes |
| --- | --- | --- | --- |
| V-3.1 / V-3.2 — hard-link grant escape found, gated, edge cases closed | Done | 2026-11-14 | Commit `14e6d1b`, tag `v3.2-hardlink-edge`, pushed to `origin/main`. Evidence: `docs/research/v3-read-isolation/hardlink-investigation.md`. |
| M-2 — Model Integration (first Phase 2 slice) | In-Progress | 2026-11-14 | Mock model behind the Policy Engine: `model.invoke` is a read-only rule-set row, `runTask` decides before it selects or invokes. No provider, no network, $0. M-3 moves the effect class to `external`. |
| M-3 — Model Registry & Human-Approval Gate | In-Progress | 2026-11-14 | Scaffold committed and pushed as `2d3435c`, tag `v3.3-model-registry`: `src/model/registry.mjs` (frozen, mock ships `external`), `src/model/approval.mjs` (`requireHumanApproval` asks the real engine under `model.invoke.external` → A5), `lain model approve`. Wiring the gate into `runTask` and proving a channel local are the milestone proper; design in `docs/model/registry.md`. |
| M-4 — Model Re-classification & Provider Integration | In-Progress | 2026-11-14 | Scaffold committed and pushed as `423e99d`, tag `v3.4-model-reclass`: `src/model/provider.mjs` (lazy `import()` loader, resolution is not authorization), `src/model/reclassify.mjs` (authorized, logged, in-memory override — the frozen registry stays the audited default), `model.reclassify` rule row (requires `model.admin`), `lain model reclassify`. The approval gate does not consult `effectiveDescriptor` yet — that wiring, with evidence that a re-classed channel is actually local, is the milestone proper; design in `docs/model/provider.md`. |
| M-5 — Real Provider Integration & Human-Approval Ledger | In-Progress | 2026-11-14 | Scaffold committed and pushed as `d84f8ff`, tag `v3.5-provider-ledger`: `src/model/provider/openai.mjs` + `gemini.mjs` (adapter-contract stubs, no network, unwired by design), `src/model/approvalLedger.mjs` (gated, shape-checked, append-only in memory), `model.approval.record` rule row, `lain model approval-record list|add`. Real adapters (free tiers, $0-first), SQLite persistence of the ledger, and the gate→`effectiveDescriptor` wiring are the milestone proper; design in `docs/model/approvalLedger.md`. |
| M-6 — Persistent Approval Ledger & Real Provider Loading | Done | 2026-11-14 | Scaffold committed and pushed with tag `v3.6-persistent-ledger`: `src/model/persistentLedger.mjs` (SQLite `approval_ledger` via `node:sqlite`, gated under `model.approval.persist`, duplicate-proof, survives reopen), `src/model/provider/sqlite.mjs` (`providers.db` binding loader, read-only open, `ProviderDBNotFound`, mock invoke — no network, no keys), `lain model approval-persist store|dump`. Real credential handling (OS credential store, never the DB) and durable-ledger wiring into the approval flow are the milestone proper; design in `docs/model/persistentLedger.md`. |
| M-7 — Real Provider Integration (transports + credentials) | Done | 2026-11-14 | Scaffold shipped as `e72c432`, tag `v3.7-real-provider`; the milestone proper is committed with tag `v3.8-live-transport`: live transports `queryLive` in `src/model/provider/openai.mjs` (ChatCompletion, `gpt-4o-mini`) and `gemini.mjs` (generateContent, `gemini-1.5-flash` free tier) via built-in `fetch`, key in headers only; policy arm **A5b** (`APPROVED_EXTERNAL_INVOCATION` — a recorded `granted` approval plus the task's own capability turns A5 into `allow_with_conditions`; A6b outranks it so an approval never substitutes for a grant); `lain model invoke --live --approval <decision-id> --ledger <db-path>` resolves the approval from the M-6 persistent ledger; OpenAI live is double-gated on `OPENAI_FUNDED=1` (no free API tier, $0-first); live tests run only under `ALLOW_LIVE=1`. Credential decision: Option A (raw key in `AGY_ACCOUNT`/`.env`) now, OS credential store as follow-up; design in `docs/model/openai.md`, `docs/model/gemini.md`, `docs/model/credentials.md`. |
