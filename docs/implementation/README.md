# Implementation documentation

This directory describes **what is implemented**, not what is planned. It is
written and maintained by the implementation task, and it is deliberately
separate from the canonical project documents at the repository root:

| Document | Role |
| --- | --- |
| `README.md` (this file) | Index and status of the implementation documentation. |
| `build-and-verification.md` | The build/check system: what runs, what each check proves, what is not covered. |
| `event-store.md` | The event store as implemented: guarantees, known limitations, the enforced store/policy boundary. |
| `host-and-budget.md` | The host probe and admission layer: what is measured, what is configured, and how a request is refused. |
| `open-issues.md` | Known limitations, unresolved guarantees and the decisions they need. |
| `../RESOURCE_BUDGET.md` | Measured hardware, configured limits and the admission rules that use them. |
| `../docs/memory/CURRENT_STATE.md` | What is true about the repository right now. |

The canonical documents at the repository root remain the source of truth for
architecture and decisions. If an implementation document and a canonical
document disagree about what exists, the implementation document is describing a
bug in the canonical document — report it rather than quietly fixing one side.

## Status at the time of writing

| Area | State |
| --- | --- |
| Build and verification environment | implemented (`npm run check`, `npm run verify`, `npm run check:self`) |
| Core primitives (ids, canonical JSON, validation, errors) | implemented with unit tests |
| Event store | implemented (`e01dbb2`), 37 store tests, 37 pass — see `event-store.md` |
| Host probe and resource admission | implemented, 35 tests, 35 pass — see `host-and-budget.md` |
| Policy decision contract | implemented — ten arms, default deny, `decide()` total — see `task-execution.md` |
| Task records | implemented — own SQLite file, refusal rows recorded, `completed` needs evidence — see `task-execution.md` |
| One authorized tool call end to end | implemented — `lain task run` on `examples/hello-task.json` reaches `completed` with real evidence |
| Model integration, agent loop | not implemented, and out of scope for V-1 |

Test count at the time of writing: `npm test` → **153 tests, 153 pass, 0 fail**.
`node tools/verify.mjs` → `checks=8 pass=7 fail=0 skipped_or_untestable=1`, the
skip being the advisory `secrets` check with gitleaks unavailable.

**Updated 2026-11-08:** gitleaks is installed (D-P9 approved), so the advisory
skip is gone: `npm run verify` → **`checks=8 pass=8 fail=0`**, exit 0. The first
real scan found two historical findings on the redaction test's own JWT fixture;
see `build-and-verification.md` §3a and `open-issues.md` Issue 2.

Nothing in this directory is a claim about a capability. A capability is claimed
only after a command has been run and the output recorded under
`artifacts/verify/`.
