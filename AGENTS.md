# Repository Instructions

These instructions apply to all work in this repository.

# Context Management Protocol

Actively manage working context throughout each project session. Conversation history is temporary; the current repository and approved project records are the persistent sources of truth. Use concise, task-relevant context and reconstruct state from evidence instead of relying on a long conversation summary.

## Source-of-truth hierarchy

Resolve conflicts using this priority:

1. Explicit current user instructions.
2. Current repository state.
3. Approved architectural decisions in `DECISIONS.md`.
4. Current project-state documentation, when present.
5. Current task instructions.
6. Conversation history.

Do not treat an old assistant response or handoff as authoritative when it conflicts with current user direction, repository evidence, or an approved decision. Flag unresolved conflicts instead of silently choosing a new architectural direction.

## Session-start verification

At the beginning of each session:

- Read the applicable repository instructions.
- Read `.lain/CURRENT_STATE.md` if present.
- Read relevant approved decisions and task-specific documentation.
- Inspect the current Git branch and working-tree status before making changes.
- Identify the active milestone, unfinished work, and blockers from project records.
- Verify important handoff claims against the repository and current tool results.

Do not reread the entire repository by default. Inspect the files and history relevant to the current task, expanding the review when evidence points to dependencies or conflicts. Never overwrite, reset, discard, or claim ownership of existing work without explicit authorization.

## Context thresholds and checkpoints

Use the harness's reported context usage when available. These are conservative operating targets, not universal model limits:

| Context used | Action |
| --- | --- |
| 0–40% | Work normally and keep notes task-focused. |
| 40–60% | Consolidate verified findings and decisions; avoid accumulating redundant exploration. |
| 60–70% | Prepare a handoff and identify a safe stopping point. |
| 70–80% | Finish only bounded work that can be safely completed; preserve the handoff. |
| 80% or more | Prefer a fresh session, continuing from a verified handoff. |

At approximately 70% usage, prepare a handoff rather than waiting until context is nearly exhausted. If the harness does not expose a reliable usage estimate, use task boundaries and signs of lost or competing context; do not invent a percentage.

## Project memory and checkpoint quality

After meaningful work, update the appropriate existing project record when one exists and the task authorizes that update. Record:

- What changed and why.
- Files affected.
- Verification performed and its actual results.
- Decisions made and their approval status.
- Remaining issues or blockers.
- The next recommended action.

Keep records concise, durable, and nonduplicative. Prefer verified discoveries, approved decisions, current blockers, architectural constraints, and reproducible procedures. Do not record speculation as fact. Label assumptions and unresolved questions. Avoid transcripts, repeated explanations, reasoning dumps, credentials, temporary chatter, and stale status claims. Do not create a parallel memory file when an existing record serves that purpose.

## Handoffs and session transitions

Before a context-driven session transition or ending a substantial session, produce a concise handoff in the project's established location or the current task response if no handoff location exists. Include:

- Project identity and objective.
- Current milestone and implementation state.
- Completed work.
- Important decisions and constraints.
- Relevant files.
- Outstanding problems and blockers.
- Exact next action.
- Commands or checks needed to continue, if applicable.
- Clear labels for verified facts, assumptions, and unresolved questions.

When starting a fresh session, read the latest handoff, verify its important claims against the actual repository and available evidence, re-establish the active task, and continue from the verified state. Never assume a prior operation completed without checking.
