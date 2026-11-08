# System Boundaries and Contracts

**Version:** 0.1 | **Status:** Proposed

## 1. Canonical ownership
Each canonical record has one owner. Other systems consume it through contracts or maintain explicitly derived projections.

| Domain | Canonical owner |
|---|---|
| Sessions and turns | Session Manager |
| Tasks and dependencies | Task Manager |
| Agent runtime state | Agent Runtime |
| Policy and approvals | Policy Engine |
| Tool/plugin manifests | Capability Registry |
| Execution process state | Execution Runtime |
| Providers/models/endpoints | Model Intelligence |
| Memory records | Memory subsystem |
| Graph entities/edges | Knowledge Graph |
| Research sources | Research subsystem |
| Experiments/evaluations | Evaluation subsystem |

## 2. Dependency direction
- Interfaces depend on Core contracts, not storage internals.
- Agent Runtime uses Task Manager, Policy Engine, Capability Registry, Model Intelligence, and Execution Runtime through interfaces.
- Execution Runtime never trusts agent-supplied permissions.
- Model adapters do not decide authorization.
- Memory and graph consume validated records/events; they do not silently rewrite source-of-truth data.
- Plugins use public capability contracts, not private Core internals.
- Business workflows use the same policy, task, audit, and budget systems.

Avoid circular dependencies. Introduce narrow contracts or events where necessary.

## 3. Request lifecycle
1. Client authenticates and submits a typed command/query.
2. Gateway validates schema and request context.
3. Policy authorizes the requested operation.
4. Owning subsystem validates state and preconditions.
5. Task/agent runtime plans bounded work.
6. Every capability invocation is re-authorized at execution time.
7. Results and state transitions are recorded.
8. Events update authorized observers and derived projections.
9. Client receives result, status, or approval requirement.

## 4. Contract requirements
Every public command/query/tool defines stable ID and version, typed input/output, authentication context, required scope, idempotency behavior, timeout/cancellation, structured errors, audit behavior, and compatibility policy.

Normalize provider-specific response structures. Preserve provider-specific metadata only in explicit extension fields.

## 5. Event envelope
Minimum fields: `event_id`, `event_type`, `occurred_at`, `source`, `schema_version`, `correlation_id`, optional `causation_id`, related entity IDs, and structured `payload`.

Accepted events are immutable audit facts. Corrections use new events or superseding records, not silent history edits.

## 6. Failure boundaries
- Provider failure cannot bypass policy or silently select an unapproved provider.
- Plugin failure cannot crash Core.
- UI disconnect cannot corrupt durable task state.
- Projection/index failure must be recoverable from canonical data.
- Timeout propagates cancellation where supported.
- Retries respect idempotency and retry limits.
- Migrations are backed up and tested before destructive changes.

## 7. Data boundaries
Secrets use a dedicated secret mechanism, never ordinary memory/logs/prompts. Project/client data is scoped. Temporary artifacts live in isolated workspaces with explicit retention. External content remains untrusted even after storage. Embeddings and graph projections retain links to canonical sources.

## 8. Interface boundary
CLI, TUI, and desktop use the same command/query/event contracts. UI layout preferences may be client-owned; task/session/policy truth may not.

## Reconciliation: collaboration ownership

The Collaboration Service owns messages, discussions, broadcasts, review records, and disputes. Task Manager remains the sole owner of task state; Agent Runtime remains the owner of agent execution state; Policy Engine remains the sole authorization authority. Collaboration records reference canonical IDs and cannot mutate those owners or grant permissions. Mods use the existing Capability Registry and Execution Runtime. Blocked-task checkpoints and resumption remain owned by Task Manager and Scheduler.
