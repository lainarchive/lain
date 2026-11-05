# Initial Engineering Backlog

**Version:** 0.1 | **Status:** Proposed starter backlog.

## Working agreement
Each issue produces one reviewable outcome and states scope, non-goals, tests, and evidence. No credentials or private user data in fixtures. Lain is authored cleanly in this repository; DSH and previous projects are research references, not source to import.

## Epic 0: Repository foundation
- **L0-001 Repository conventions:** document layout, naming, formatting, lint, tests, and contribution workflow. Acceptance: usable from a clean checkout.
- **L0-002 Toolchain proof of concept:** validate Rust as the leading candidate with a small vertical slice. Record build time, complexity, test ergonomics, footprint, and integration findings. Do not build the full Core yet.
- **L0-003 CI baseline:** clean checkout, format, lint, unit tests, and build on the initial supported platform. Avoid complex release automation.

## Epic 1: Core skeleton
- **L1-001 Command/query errors:** request IDs, typed errors, validation, and versioning. Malformed requests return structured errors without crashing.
- **L1-002 Event envelope:** ID, type, time, source, schema, correlation, causation, subject, and payload. Validate valid and invalid events.
- **L1-003 Configuration:** explicit paths, defaults, validation, and safe diagnostics. Invalid config fails clearly; secrets are never printed.
- **L1-004 Structured logging:** levels, timestamps, correlation IDs, and redaction. Tests prove secret-like values are redacted.

## Epic 2: Persistence and sessions
- **L2-001 SQLite prototype:** migrations, transactions, backup/restore, and concurrent access. Record limitations and performance.
- **L2-002 Session records:** create, read, list, append, and restart recovery. State survives restart with stable IDs.

## Epic 3: Model interface
- **L3-001 Provider-neutral contract:** request, response, streaming, tool calls, usage, errors, and capability types. Contract tests avoid provider wire-format coupling.
- **L3-002 One provider adapter:** explicitly configured provider; no automatic fallback. Mock tests cover success, streaming, timeout, malformed response, and failure.
- **L3-003 Fail-closed router:** allowlist, capabilities, known-cost state, budget ceiling, and auditable selection. Unknown pricing and disallowed providers are rejected.

## Epic 4: First agent and tools
- **L4-001 Bounded agent loop:** one agent/task, limited turns, explicit stop conditions. Deterministic task emits an inspectable trace.
- **L4-002 Native tool schema:** ID/version, input/output schema, permissions, timeout, resource limits, and errors. Invalid input is rejected before execution.
- **L4-003 Tool authorization:** policy check at invocation time. Denied actions never reach the executor.

## Epic 5: Tasks and recovery
- **L5-001 Task lifecycle:** records, state transitions, completion criteria, and result references. Illegal transitions are rejected and persisted.
- **L5-002 Cancellation/timeout:** cancellation tokens, deadlines, bounded retries, and child propagation. Supported child operations stop and final state is recorded.
- **L5-003 Checkpoint/recovery:** safe resumable state. Restart resumes or safely fails without duplicating non-idempotent effects.

## First milestone
Complete L0-001 through L0-003, then L1-001 through L1-004. Do not start advanced orchestration or desktop work before the foundation is reproducible.
