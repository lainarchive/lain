# Lain Architecture

**Version:** 0.1  
**Status:** Proposed architecture; not implemented.

## 1. Product definition

Lain is a general-purpose, local-first AI operating environment. It coordinates models, agents, tasks, tools, knowledge, and execution behind a durable Core, then exposes that Core through multiple interfaces. Software engineering is a core capability, not the product's only purpose.

**Lain is the system that coordinates intelligence and action, not a single model.**

## 2. Principles

- Local-first where practical; remote providers remain optional.
- Provider- and model-independent.
- Modular internal boundaries before premature microservices.
- Durable sessions and tasks independent of UI lifetime.
- Authorization enforced outside model prompts.
- Explicit cost, resource, and execution limits.
- Provenance for important knowledge, research, and decisions.
- Recoverability through checkpoints, cancellation, and bounded retries.
- Evidence-driven development and independently verifiable outcomes.
- Extensions never receive unrestricted authority by default.

## 3. Logical architecture

```text
Interfaces: CLI | TUI | Desktop (later) | Remote client (later)
                         |
               Core command/query API
                         |
       +-----------------+------------------+
       |                 |                  |
   Sessions            Tasks            Policy Engine
       |                 |                  |
       +------------- Agent Runtime --------+
                         |
               Capability Registry
             Tools | Skills | Plugins | MCP
                         |
                 Execution Runtime
          Local | Workspace | Container | Remote
                         |
                Model Intelligence
          Providers | Endpoints | Models | Router
                         |
                  Shared Knowledge
             Memory | Graph | Research
                         |
                Specialized Systems
       Evaluation | Foundry | Hardware | Business
```

This is a logical map, not a requirement that each box be a separate process or package. Start with a modular Core. Split processes only when security, reliability, or resource measurements justify it.

## 4. Core platform

### Gateway
Accepts authenticated client commands and queries, validates schemas, applies authorization, dispatches requests, and returns structured results. Public contracts are versioned.

### Sessions
A session is a durable work context, not a UI tab. It references conversation turns, tasks, participants, artifacts, model usage, and checkpoints. Closing a client does not implicitly terminate a task.

### Events
Important state changes are recorded with event ID, type, timestamp, source, related entity IDs, schema version, correlation ID, causation ID when available, and structured payload. Event history supports audit, recovery, UI updates, and projections. Full event sourcing is not mandatory for every subsystem.

### Tasks
Tasks are first-class records with objective, parent, dependencies, assigned agent, required capabilities, policy references, workspace, resource/budget limits, completion criteria, status, checkpoints, and deliverables.

Suggested states: `created`, `pending`, `scheduled`, `running`, `waiting`, `interrupted`, `failed`, `cancelled`, `completed`. Completion requires criteria and verification, not merely an agent's claim.

### Policy engine
Authorizes actions independently of model output. Decisions consider identity, action, scope, resource, environment, risk, budget, and approval. Denials fail closed.

### Agent runtime and scheduler
Run agent loops, coordinate tool calls, and schedule work based on dependencies, priority, capability, provider limits, throughput, CPU/RAM/GPU availability, budget, and concurrency limits. Default to shallow delegation. Child agents receive explicit context packages, not entire parent histories.

## 5. Capabilities

- **Tools:** executable capabilities with typed input/output schemas, authorization, timeout, resource limits, and structured errors.
- **Skills:** reusable procedural instructions; not necessarily executable.
- **Plugins:** extensions that may contribute tools, skills, integrations, commands, services, or data sources.
- **MCP:** a supported integration protocol, not Lain's exclusive internal tool architecture.
- **Creator Engine:** converts a user-described extension into a researched, designed, implemented, tested, documented, and packaged candidate. Creation and activation are separate; installation requires approval.

## 6. Execution

Agents propose actions; execution backends enforce policy and perform authorized actions. Potential backends include restricted local workspaces, containers, VMs, and explicitly configured remote execution. Prefer deterministic APIs and accessibility interfaces over visual automation when practical.

Controls include filesystem/network scope, process restrictions, timeouts, resource limits, audit, approval, cancellation, checkpoints, and rollback where possible. Self-development occurs in an isolated workspace or branch, passes tests and review, and requires authorized integration.

## 7. Model intelligence

Represent providers, endpoints, protocols, credential references, and models separately. Capabilities belong to a verified endpoint/model combination. Normalize streaming, tool calls, usage, errors, finish reasons, and cost metadata.

The router applies hard constraints first: required capabilities, context, availability, privacy, provider allowlist, and budget. It then scores eligible candidates. Unknown pricing is not free. Fallbacks must not weaken active policy. Track estimated cost separately from provider-reported cost.

## 8. Memory and knowledge graph

Memory categories: user, project, agent, episodic, semantic, prospective, and procedural.

Formation pipeline: candidate detection, classification, source validation, duplicate detection, conflict detection, confidence evaluation, policy/approval, persistence, indexing. Do not automatically store credentials, unverified speculation, temporary chatter, or external prompt injections as trusted memory.

Initial storage proposal: SQLite for canonical structured records, FTS5 for lexical search, optional embeddings when evaluation justifies them.

The graph connects users, projects, sessions, agents, tasks, models, providers, tools, skills, plugins, memories, decisions, files, sources, experiments, businesses, and opportunities. Relationships carry provenance, confidence, timestamps, and validity. Begin with relational entity/edge tables; add a graph database only if benchmarks demonstrate need.

## 9. Specialized systems

- **Research Lab:** source-backed discovery with author, date, version, evidence, confidence, and provenance.
- **Evaluation Lab:** reproducible model and system evaluations using task outcomes, not only tokens/second.
- **Model Foundry:** orchestrates existing inference/training engines rather than recreating them.
- **Hardware Intelligence:** detects hardware and estimates model fit, memory use, offload behavior, and performance with uncertainty.
- **Business Intelligence:** market research, opportunity discovery, validation, planning, analytics, and bounded operations. External commitments and regulated actions require appropriate owner authorization.

## 10. Interfaces

The Core is headless. CLI is the first interface; TUI follows when the Core contracts stabilize; desktop is later. Interfaces observe and control shared Core state through versioned APIs. They do not own canonical task, session, policy, or memory state.

## 11. Data and reliability

Initial direction: SQLite for structured records and event persistence, FTS5 for lexical search, filesystem for large artifacts, and isolated workspaces for execution. Use schema versions, migrations, backup/restore, structured logs, correlation IDs, graceful shutdown, bounded retries, cancellation propagation, and recovery tests.

## 12. Security

Security is enforced by trusted Core/runtime components, not by prompts. Treat external documents, repositories, websites, and tool outputs as untrusted input. Keep secrets outside ordinary memory. Scope plugin permissions. Require approval for sensitive operations. Protect security policy and spending limits from agent self-modification.

## 13. Technology candidates

| Area | Candidate | Status |
|---|---|---|
| Core | Rust | Preferred candidate, validate with a vertical slice |
| TUI | Ratatui | Candidate |
| Desktop | Tauri | Leading candidate, benchmark |
| Desktop alternative | Electron | Retained alternative |
| Structured storage | SQLite | Preferred initial choice |
| Lexical search | FTS5 | Preferred initial choice |
| Graph storage | SQLite entity/edge tables | Initial choice |
| Telemetry | OpenTelemetry | Candidate |
| Inference | Existing engines via adapters | Direction |

No candidate becomes a permanent commitment without a proof of concept or documented decision.

## 14. Initial product boundary

The first useful release should provide a CLI, one configured model provider, persistent sessions, one reliable agent, approved tool execution, basic tasks, policy enforcement, inspectable events, interruption/recovery, basic memory, structured logs, and usage/cost tracking.

Defer full swarms, advanced GraphRAG, model training, marketplace, desktop/mobile, unattended business operations, and self-modifying production Core.
