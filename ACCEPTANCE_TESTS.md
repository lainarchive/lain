# Acceptance Tests

**Version:** 0.1 | **Status:** Required behavioral targets; implementation pending.

These are targets to turn into automated tests as components are implemented. A listed test is not evidence that implementation exists.

## Repository and build
- **AT-001 Clean checkout:** fresh clone builds using documented steps.
- **AT-002 Reproducible checks:** format, lint, and tests run from documented commands.
- **AT-003 Secret hygiene:** repository and fixtures contain no live credentials.

## Sessions and events
- **AT-010 Persistence:** create session, append turns/events, restart, recover same state.
- **AT-011 Event schema:** malformed events rejected with structured errors.
- **AT-012 Correlation:** task events traceable through correlation/causation metadata.
- **AT-013 UI independence:** client disconnect does not corrupt durable task state.

## Tasks and agents
- **AT-020 State machine:** invalid task transitions rejected.
- **AT-021 Bounded execution:** turn/time/resource limits enforced.
- **AT-022 Cancellation:** cancellation propagates to supported child operations.
- **AT-023 Recovery:** interrupted work resumes from safe checkpoint or fails safely.
- **AT-024 Verifiable completion:** completion requires criteria or explicit verification limitation.
- **AT-025 Delegation:** child agents cannot exceed parent permissions.

## Models and cost
- **AT-030 Provider isolation:** Core contracts are independent of provider wire formats.
- **AT-031 Unknown pricing:** unknown-price model excluded from free-only routing.
- **AT-032 No paid fallback:** failure cannot silently route to paid/unapproved endpoint.
- **AT-033 Capabilities:** unsupported tool/vision/structured-output features are not assumed.
- **AT-034 Budget:** hard limits block requests even when model asks to continue.
- **AT-035 Cost provenance:** estimates and provider-reported usage stored distinctly.

## Tools and execution
- **AT-040 Authorization:** denied invocation never reaches executor.
- **AT-041 Path scope:** tool cannot access outside authorized workspace.
- **AT-042 Network scope:** restricted execution cannot reach disallowed destinations.
- **AT-043 Timeout:** timed-out operation stops or is explicitly marked uncontained.
- **AT-044 Output limits:** oversized tool output is bounded safely.
- **AT-045 Plugin containment:** plugin crash cannot crash Core or expand permissions.

## Memory and knowledge
- **AT-050 Provenance:** retrieved memory exposes source and timestamp.
- **AT-051 Conflicts:** contradictory records surfaced, not silently merged.
- **AT-052 Untrusted content:** external prompt injection is not promoted to trusted instruction/memory.
- **AT-053 Secret exclusion:** credentials are not automatically stored as ordinary memory.
- **AT-054 Graph traceability:** important relationships trace to evidence/source.

## Security and recovery
- **AT-060 Policy integrity:** agents cannot modify protected policy or spending limits.
- **AT-061 Approval scope:** approval for one action does not authorize another.
- **AT-062 Audit:** sensitive actions record principal, target, decision, outcome without secret values.
- **AT-063 Backup/restore:** backup restores consistent database and metadata.
- **AT-064 Migration safety:** failed migration preserves recoverable prior state.
- **AT-065 Kill control:** authorized stop halts active execution within documented limits.

## Interfaces
- **AT-070 Shared state:** CLI and second client observe same session/task state.
- **AT-071 Accessibility:** controls support keyboard use and accessible labels.
- **AT-072 Headless:** Core workflows run without desktop UI.

## Release rule
A feature is not complete because a test is written. Record implementation, test command, result, environment, and commit. Report skipped/unverified tests explicitly.
