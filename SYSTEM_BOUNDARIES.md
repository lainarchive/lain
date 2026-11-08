# System Boundaries and Contracts

**Version:** 0.1 | **Status:** Proposed

## 1. Canonical ownership
Each canonical record has one owner. Other systems consume it through contracts or maintain explicitly derived projections.

**Single-writer rule (added 2026-11-08, with implementation evidence; scope corrected 2026-11-08 by measurement).** The event log has exactly one write transaction at a time. Serialization is enforced by the store
itself through the database's own write lock, not by convention and not by a lock file: a writer takes the write lock for the duration of each transaction and re-takes it immediately after committing, and a second process is refused rather
than queued. This is transaction serialization, not continuous process ownership: between committing a batch and re-taking the lock there is a real window, and a process that loses that race is refused with `STORE_LOCK_LOST` and must not write again. Measured 2026-11-08 over repeated runs, a competing process acquired the lock in that window while the first writer was mid-session and still committing batches.
The rule exists because the audit measured what its absence costs — with commits per document, 963 of 1,766 observations showed torn reads; with one
transaction per batch, 0 of 1,212 did. The Event Store owns persistence and ordering only. It does not own authorization, which remains the Policy Engine's alone.

| Domain | Canonical owner |
|---|---|
| Sessions and turns | Session Manager |
| Events and the event log | Event Store |
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
