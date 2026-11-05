# Architecture Decision Records

**Version:** 0.1 | **Status:** Initial register. Update when evidence or user direction changes.

Statuses: **Accepted** = approved direction; **Proposed** = recommended but unproven; **Experiment required** = validate before locking; **Deferred** = postponed.

## ADR-001: Lain is an independent project
**Status:** Accepted  
**Decision:** Lain starts clean in this repository. DSH and previous projects are research inputs only; do not import their source as the starting implementation.  
**Reason:** Preserve a clean architecture and avoid inherited constraints.

## ADR-002: Local-first and provider-independent
**Status:** Accepted  
**Decision:** Core state and policy are local-first; providers are adapters behind stable interfaces.  
**Reason:** Portability, privacy, cost control, resilience.

## ADR-003: Core owns canonical state
**Status:** Accepted  
**Decision:** Interfaces are clients. Sessions, tasks, policy, and canonical records belong to Core subsystems.  
**Reason:** Multiple interfaces must observe consistent state.

## ADR-004: Authorization is external to prompts
**Status:** Accepted  
**Decision:** Trusted policy and execution components authorize every capability invocation.  
**Reason:** Model instructions are not a security boundary.

## ADR-005: Unknown cost fails closed
**Status:** Accepted  
**Decision:** Unknown pricing/tier status is not free. Fallbacks cannot weaken active cost, privacy, capability, or provider policy.  
**Reason:** Prevent surprise charges and policy bypass.

## ADR-006: Start as a modular monolith
**Status:** Proposed  
**Decision:** Begin with clear internal module boundaries in one Core process. Split processes only when isolation, reliability, or measurements justify it.  
**Validation:** Build a vertical slice and measure startup, memory, testability, and isolation needs.

## ADR-007: SQLite for initial structured storage
**Status:** Proposed  
**Decision:** Use SQLite for initial structured records and FTS5 for lexical search; large artifacts live in the filesystem.  
**Validation:** Test concurrent access, migrations, backup/restore, event volume, and graph queries.

## ADR-008: Relational graph first
**Status:** Proposed  
**Decision:** Start with entity/relationship tables in SQLite. Add a graph database only if representative benchmarks justify it.  
**Validation:** Benchmark path, neighborhood, temporal, and provenance queries.

## ADR-009: CLI-first sequencing
**Status:** Accepted for initial sequencing  
**Decision:** Validate Core through CLI before desktop investment. TUI follows when contracts stabilize; desktop comes later.  
**Reason:** Fast feedback and automation-friendly testing.

## ADR-010: Desktop framework remains open
**Status:** Experiment required  
**Decision:** Tauri leads; Electron remains an alternative.  
**Validation:** Compare startup, idle RAM/CPU, bundle size, graph rendering, native integration, accessibility, and maintenance.

## ADR-011: Rust is preferred but not locked
**Status:** Experiment required  
**Decision:** Rust is the leading Core candidate. Validate development speed, ecosystem fit, async complexity, and integration through a small vertical slice.  
**Validation:** Prototype config, CLI, event persistence, and one model adapter.

## ADR-012: Extension creation differs from activation
**Status:** Accepted  
**Decision:** Creator Engine produces a candidate; validation and explicit approval are required before activation.  
**Reason:** Generated and third-party code is untrusted until reviewed.

## ADR-013: Advanced autonomy is deferred
**Status:** Accepted  
**Decision:** No unattended external operations or autonomous financial commitments in the initial release.  
**Reason:** Establish safety, reliability, and authority boundaries first.

## Open decisions
Exact language/workspace structure; async runtime; event persistence/projections; execution isolation; plugin isolation; embeddings; remote access; desktop framework; whether a graph database is ever needed. Resolve through user direction, proof of concept, threat model, or benchmark. Do not silently promote candidates to accepted decisions.