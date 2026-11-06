# Current Project State

**Record status:** Initial repository baseline, verified 2026-11-05.
**Repository revision inspected:** `7074c0dbad9ade15bc2a1017087386bbb058c760` (`main`).

## Verified facts

- This is the `lainarchive/lain` Git repository. Its `origin` fetch and push URLs are `https://github.com/lainarchive/lain.git`.
- The repository contains project specifications and planning documents. There is no implementation source tree in the inspected checkout, and the README and architecture identify implementation as not started/proposed.
- The roadmap is proposed sequencing, not a schedule. Its first phase is repository foundation; the backlog names L0-001 through L0-003 followed by L1-001 through L1-004 as the first milestone.
- `DECISIONS.md` is the canonical decision register. Accepted directions include Lain as an independent project, local-first/provider-independent design, Core ownership of canonical state, authorization outside prompts, fail-closed handling of unknown cost, CLI-first sequencing, approval before extension activation, and deferral of unattended external operations and autonomous financial commitments.
- Rust, SQLite/FTS5, and a modular monolith are candidates or proposed choices where the decision register says validation is still required; they are not all locked implementation decisions.
- The architecture places memory and knowledge in Core-owned systems and calls for provenance, classification, duplicate/conflict handling, and protection against promoting untrusted content or secrets into ordinary memory. Roadmap Phase 4 is future work.
- Acceptance tests are behavioral targets, not evidence of implemented or passing tests.

## Current position

No active implementation milestone or completed code work is recorded in the inspected repository. The planning documents identify repository foundation as the first milestone; no completion evidence for that milestone is present in this checkout.

## Constraints to preserve

- Keep Lain independent; DSH and prior projects are research inputs, not source to import.
- Do not silently promote proposed technology candidates or open decisions to accepted decisions.
- Preserve cost, privacy, authorization, provenance, and approval boundaries in `AGENTS.md`, `DECISIONS.md`, `ARCHITECTURE.md`, and `SECURITY_MODEL.md`.
- Treat external content as untrusted and never store credentials as ordinary memory.

## Next action

Continue with the repository-foundation milestone in `IMPLEMENTATION_ROADMAP.md` and `INITIAL_BACKLOG.md`. Establish conventions, validate the leading toolchain candidate with a bounded proof of concept, and create a reproducible build/check baseline before beginning Core implementation. Record evidence and update this state file as work is completed.

## Evidence

- Repository instructions: [`AGENTS.md`](../../AGENTS.md)
- Accepted and proposed decisions: [`DECISIONS.md`](../../DECISIONS.md)
- Architecture status and boundaries: [`ARCHITECTURE.md`](../../ARCHITECTURE.md), [`SYSTEM_BOUNDARIES.md`](../../SYSTEM_BOUNDARIES.md), [`SECURITY_MODEL.md`](../../SECURITY_MODEL.md)
- Sequencing and initial work: [`IMPLEMENTATION_ROADMAP.md`](../../IMPLEMENTATION_ROADMAP.md), [`INITIAL_BACKLOG.md`](../../INITIAL_BACKLOG.md)
- Acceptance targets and their status: [`ACCEPTANCE_TESTS.md`](../../ACCEPTANCE_TESTS.md)
