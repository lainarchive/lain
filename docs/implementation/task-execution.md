# Task execution

V-1 delivers one thing: **a CLI that accepts one task, decides every step
through a default-deny Policy Engine, runs one local tool inside a contained
workspace, records every action, evaluates the acceptance criteria, and can
prove afterwards from its own log what it did and what it could not prove — with
no model call at all.**

This document describes what exists in the repository. Where something is not
covered, it says so rather than implying coverage.

## The path one task takes

```
lain task run --task examples/hello-task.json
        │
        ├─ contract.mjs      validateTaskDraft  → no criteria? refused, nothing written
        ├─ tasks/store.mjs   create            → state submitted
        ├─ policy/decide.mjs task.admit        → A6b / A8 / A3 / A9 …
        │      refusal → state failed, no workspace, no tool
        ├─ tasks/store.mjs   grantCapabilities → granted once, intersection of declared ∩ required
        ├─ policy/decide.mjs tool.<id>         → decided before anything exists on disk
        ├─ exec/workspace.mjs create           → <LAIN_HOME>/workspaces/<task_id>
        ├─ tools/invoke.mjs  invoke            → records policy.decided, then runs
        ├─ agent/task-runner evaluateCriteria  → passed / failed / not_evaluated
        └─ tasks/store.mjs   setResult, transition completed (needs evidence)
```

Every arrow that changes something happens **after** a decision was recorded,
and the decision carries the `decision_id` that the executor demands. A tool call
with no decision is refused with `ToolError.code === 'NO_DECISION'` and records
nothing.

## The Policy Engine

`src/policy/arms.mjs` holds the arm table; `src/policy/decide.mjs` evaluates it.

| Arm | Outcome | Reason code | Selected when |
| --- | --- | --- | --- |
| A1 | `deny` | `EXPLICIT_DENIAL` | a human answered no |
| A2 | `deny_indeterminate` | `APPROVAL_TIMED_OUT` | the approval window closed with no answer |
| A3 | `deny` | `POLICY_RULE_FORBIDS` | the rule set does not list the tool |
| A5 | `require_approval` | `EFFECT_CLASS_REQUIRES_APPROVAL` | effect class is `external` or `local_irreversible` |
| A4 | `deny_budget` | `BUDGET_EXCEEDED` | the context sets `budget.exceeded` |
| A6 | `defer` | `POLICY_EVALUATION_INCOMPLETE` | the context is not complete |
| A6b | `defer` | `CAPABILITY_NOT_GRANTED` | the tool needs a capability the task does not hold |
| A7 | `allow` | `READ_ONLY_WITHIN_GRANT` | read-only, inside the grant |
| A8 | `allow_with_conditions` | `REVERSIBLE_WITHIN_WORKSPACE` | reversible, inside the grant; condition `workspace_only` |
| A9 | `defer_policy_error` | `EVALUATION_ERROR` | a predicate threw — the catch-all |

Three properties are worth stating plainly.

**Evaluation order is not the table order.** A rule outranks an approval prompt
(`A3` before `A5`), so a forbidden action never reaches a human as a question.
The order lives in `decide.mjs` as one array, and `AT-V1-POL-01` asserts every arm
is reachable — an arm nothing can select is a rule that is not in force.

**`decide()` is total.** It never throws and never returns undefined. A predicate
that throws becomes A9 with the error text in the decision, so "the policy
crashed" is a recorded outcome rather than an unhandled exception.

**Only a human's `deny` is retryable.** `deny_budget` is terminal for this task;
`deny_indeterminate` is never retried, because the caller never learned what the
user wanted and retrying is guessing on their behalf. A6b is not a denial at all —
it says "this task does not hold that authority", which is a different question
from "this action is forbidden".

### A6b exists because A9 was lying

Before `A6b`, a request needing an ungranted capability matched no arm and fell
through to A9 — so a plain, correct, expected refusal was reported as
`EVALUATION_ERROR`, "the policy crashed". The answer was right and the reason was
wrong, which is how a real evaluation error stops being visible. The acceptance
run for `capabilities: []` is what surfaced it.

### Effect classes

`read_only`, `local_reversible`, `local_transactional`, `external`,
`local_irreversible`. An absent, empty or unrecognised class is treated as
`external` — the class that requires a human — so a mislabelled tool degrades to
asking rather than to acting.

## Capability grants

A task declares the capabilities it wants. The runner computes

```
granted = tool.requires ∩ task.capabilities
```

and grants **only that**, once, at admission. `grantCapabilities` refuses a second
call with `CAPABILITIES_ALREADY_GRANTED` rather than merging, because merging is
how a running task widens its own authority.

The rule this protects is stated in the earlier design as *requirements ≠
permissions*, and it was violated in the first implementation: the runner passed
`registry.requiredCapabilities(tool_id)` into the policy context as though it had
been granted, which made the grant check true by construction. A task with
`capabilities: []` ran a script. The end-to-end acceptance test caught it; the
fix is the intersection above plus the policy-side check that the grant actually
covers the requirement.

## The workspace

`<LAIN_HOME>/workspaces/<task_id>`, created **after** the tool decision, so a
refused task leaves nothing on disk to clean up.

- `buildEnv` constructs the child environment: `PATH`, `SystemRoot`, `COMSPEC`,
  `PATHEXT`, `TEMP`, `TMP`, `LAIN_WORKSPACE`. `USERPROFILE`, `APPDATA`, `HOME`,
  `AWS_*` and `GITHUB_TOKEN` are absent by construction, not by accident.
- `TEMP` and `TMP` point inside the workspace.
- `scrubPath` refuses anything resolving outside the workspace, and refuses
  Windows device paths (`\\?\`, `\\.\`) before they are resolved at all.
- `workspace.run` is the **only** spawn site outside `src/exec/one-shot.mjs`, and
  `tools/check/process-boundary.mjs` fails the build if a second one appears.
- A filesystem failure is translated into a `WorkspaceError` with a code
  (`PATH_OCCUPIED`, `WRITE_FAILED`), never leaked as a bare `Error`.

## Acceptance criteria

`evaluateCriteria` gives every criterion exactly one of `passed`, `failed` or
`not_evaluated`. The property that matters is that **an unevaluable criterion is
never `passed`**:

- an `artifact` criterion with no path → `not_evaluated`
- a `command` criterion → `not_evaluated`, and deliberately not executed, because
  a second execution path would bypass the environment allow-list, the timeout
  and the scrub
- an unknown kind → `not_evaluated`, so adding a kind cannot silently widen what
  counts as success
- an `assertion` with no `exit_code` → `not_evaluated`

A task reaches `completed` only when every required criterion passed **and** at
least one piece of evidence was recorded. The second half is enforced in the
store, from the stored result, so it is not a flag the caller can set.

## Where state lives

| Path | Contents |
| --- | --- |
| `<LAIN_HOME>/events.db` | the append-only event log |
| `<LAIN_HOME>/tasks.db` | task records, capabilities and transitions (its own file) |
| `<LAIN_HOME>/workspaces/<task_id>/` | the task's workspace |

`LAIN_HOME` overrides the base; the default is `%LOCALAPPDATA%\Lain`. State is
deliberately outside the repository so that a task cannot reach its own log by a
relative path, and the task store is a separate file so that a defective task
store cannot imperil the event log.

## CLI

```
lain task run --task <file.json> [--allow <tool_id>] [--keep-workspace] [--json]
lain task show <task_id> [--json]
lain store verify [--json]
```

Exit codes: `0` ok, `2` usage, `3` refused, `4` failed. In `--json` mode stdout is
exactly one JSON document — the "workspace removed" notice goes to stderr, so a
consumer never has to strip a trailing line.

A task file is flat: `objective`, `acceptance_criteria`, `capabilities`,
`effect_class`, `budget`, `tool_id`, `tool_arguments`. `tool_arguments.script`
accepts a string or an array of lines, because a JSON string would force a whole
program onto one physical line.

## What this is not

There is no model call anywhere in this path, and no network access is attempted
or restricted. Reads are unrestricted. There is no cancellation, no Job Object
memory/time limit, no UI and no interactive approval prompt — `--allow <tool_id>`
is the only way a v0.1 approval is expressed, and the approval *ledger* with its
binding and timeout exists and is tested but is not yet wired to a prompt.

**Lain is not a sandbox.** The measured containment claim is a restricted-token
plus low-integrity workspace and a process tree that a controller can terminate;
it is not a security boundary against a determined program, and this document
does not claim otherwise.
