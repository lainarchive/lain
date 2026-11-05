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