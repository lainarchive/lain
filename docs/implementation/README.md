# Implementation documentation

This directory describes **what is implemented**, not what is planned. It is
written and maintained by the implementation task, and it is deliberately
separate from the canonical project documents at the repository root:

| Document | Role |
| --- | --- |
| `README.md` (this file) | Index and status of the implementation documentation. |
| `build-and-verification.md` | The build/check system: what runs, what each check proves, what is not covered. |
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
| Event store | not implemented (M-1 Step 2) |
| Host probe and resource admission | not implemented (M-1 Step 3) |
| Policy decision contract | not implemented |
| Task records | not implemented |
| Model integration, agent loop | not implemented, and out of scope for M-1 |

Nothing in this directory is a claim about a capability. A capability is claimed
only after a command has been run and the output recorded under
`artifacts/verify/`.
