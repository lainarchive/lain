# 06 — Bounded-Agent Execution Contract (M-2)

**Status:** PROPOSED specification. **No M-2 code exists; no model call was made.**
**Date:** 2026-11-08
**Scope:** the smallest honest execution contract for `Lain v0.1.0 — One Bounded Agent`: task lifecycle, capability grants, tool authorization, cancellation hook-up, results and failures.
**Verification classification:** VERIFIED (the store, policy-shaped decisions and admission that already exist) · PROPOSED (everything M-2 adds) · UNRESOLVED.
**Depends on:** [06-one-bounded-agent-specification.md](../m1-foundation-readiness/06-one-bounded-agent-specification.md), [01-cancellation-semantics.md](01-cancellation-semantics.md), [07-model-binding-contract.md](07-model-binding-contract.md), [05-resource-and-lifecycle-contracts.md](05-resource-and-lifecycle-contracts.md), [04-filesystem-process-network-boundaries.md](04-filesystem-process-network-boundaries.md).

---

## 1. What M-2 is, in one sentence

**A single task runs a single local model in a bounded loop that may call one authorized tool at a time inside a low-integrity workspace, records every step in the event store, and can be cancelled with a verified process-tree kill and an honest statement of what it could not prove.**

**Out of scope for M-2 (EUR):** delegation, multiple agents, swarms, the knowledge graph, embeddings, plugins, MCP, Creator Mode, UI, unattended operation, any paid or remote provider, and any tool execution outside the containment of §6.

## 2. Prerequisites and their real state

| # | Prerequisite | State | Evidence |
|---|---|---|---|
| P-1 | Reproducible verification environment | **Implemented and verified** | `npm test` 110/110, `npm run check` 7 pass/1 skip, `check:self` 8/8 |
| P-2 | Event store with single-write-transaction semantics | **Implemented and verified** | 37/37 store tests; `STORE_LOCK_LOST` measured and documented |
| P-3 | Host probe + resource admission | **Implemented, partially verified** | 35 tests on fixtures; the budget defaults are RECOMMENDED, not measured |
| P-4 | Policy decision contract (`decide()`, total, default deny) | **Specified only** | M-1 Step 4 was descoped; no `src/policy/` exists |
| P-5 | Task contract and records | **Specified only** | No `src/tasks/` |
| P-6 | Model binding | **Specified only** | §7 of this package |
| P-7 | Contained execution (Low IL + Job Object) | **Mechanism verified, integration not written** | Verification E |
| P-8 | Tool execution contract | **Specified only** | This document |
| P-9 | Cancellation cascade | **Specified, recommended model** | `01-cancellation-semantics.md` |
| P-10 | Result recording with `indeterminate[]` | **Specified only** | This document |

**ESR — the honest reading:** four of ten prerequisites are implemented, and the four are the deterministic ones. M-2 begins with P-4, P-5 and P-7, in that order, because nothing else can be tested without them.

## 3. The task contract

```
task {
  task_id            ULID                      assigned by the controller, never by the model
  objective          text                      the user's words, stored verbatim
  acceptance_criteria [ {id, statement, check: {kind: command|artifact|assertion, spec}, required} ]
                                               at least one required, or the task is not admitted
  capabilities       [ capability_id ]         granted at admission; IMMUTABLE afterwards
  workspace          absolute path             created fresh for this task; never inherited
  budget             {max_model_calls, max_tool_calls, max_wall_ms, max_tokens, max_processes}
  effect_class       read_only | local_reversible | local_transactional | external | local_irreversible
  deadline           timestamp                 wall clock; expiry is a terminal outcome
  state              submitted | admitted | running | cancelling | completed | failed
                     | cancelled | cancel_failed | indeterminate
  result_ref         nullable                  artifact + event range, not a transcript
  error              nullable {code, message, detail}
  audit              {created_at, created_by, admitted_by, decision_ids[], parent_task_id: null}
}
```

**Rules (PROPOSED):**
- **No checkable acceptance criterion → not admitted.** This is what makes `completed` mean something; it is also the only field a model cannot invent on the user's behalf.
- **Capabilities are fixed at admission.** A mid-task request for a new capability is a **new admission decision**, which for M-2 means a human prompt — never a silent widening.
- **`objective` is the user's text, unmodified.** A model's paraphrase is a separate field and never replaces the record.
- **No transcript in the task record.** Handoffs and results carry references (paths, event ids, digests). Rationale measured during research: a system prompt plus three tool schemas is 396 tokens and one tool result takes it to 618 — 15.1 % of a 4 096-token window before any work happens.

## 4. Lifecycle

1. **Create** — the controller writes `task.created` with the objective and criteria. Nothing has executed.
2. **Admit** — Policy decides. Refusals are recorded with a reason code; an approval that times out is `deny_indeterminate` and is **never** retried.
3. **Bind** — a model binding is selected deterministically (§7 of [07-model-binding-contract.md](07-model-binding-contract.md)); digest and cost class are checked before any call.
4. **Probe and budget** — the existing host probe runs, admission computes the budget, and a refusal ends the task before any model call.
5. **Loop** (bounded by every limit simultaneously):
   a. Build context from the system prompt, tool schemas, objective and **only** the last tool result. Exceeding the context budget is a **refusal**, never a silent truncation.
   b. One model call. Recorded before its output is used.
   c. If it proposes tool calls: authorize **each one** through Policy; execute at most one at a time; record the invocation and its result; feed the result (or the denial) back.
   d. If it produces a result: validate against the result schema, then run the acceptance checks.
   e. Stop on any stopping condition, and **record which one**.
6. **Check** — each `required` criterion is evaluated as a command, artifact digest, or assertion. A criterion that cannot be evaluated is `not_verified`, never assumed passed.
7. **Finalise** — terminal state + `task.result` with the four lists below. The state is `completed` **only if** every required check passed and no rejection is open.

**Stopping conditions, each recorded:** objective met with evidence attached · budget exhausted · the same failure twice (fail fast, do not loop) · a decision the agent is not authorized to make · cancellation received · approval denied or indeterminate · criteria proven unsatisfiable by evidence.

## 5. Result schema — the asymmetry that makes "done" mean something

```
result {
  claims[]        what the agent says it achieved        (NEVER sufficient by itself)
  artifacts[]     {path, bytes, sha256}                  (verified by the controller)
  evidence[]      commands run, exit codes, outputs, event ids   (MAY be sufficient)
  checks[]        acceptance criteria and their observed outcomes
  not_verified[]  what could not be checked, and why
  indeterminate[] effects that may or may not have happened
}
```

**ESR — one rule:** *a claim is never sufficient; evidence may be.* A `completed` state with an empty `evidence[]` is a defect in the checker, not a success. `indeterminate[]` is a first-class outcome, not an apology.

## 6. Tool authorization contract

```
decision {
  decision_id, outcome: allow | deny | allow_with_conditions | require_approval
                      | deny_indeterminate | defer,
  reason_code, reason, conditions[]?, approval_id?, rule_id, budget_after, decided_at
}

invoke(tool_id, args, task_id, decision_id, workspace) -> result {
  status: ok | error | denied | timeout | partial,
  stdout, stderr, exit_code, artifacts[], duration_ms, resource_peak, effect_observed
}
```

**Rules (PROPOSED):**
- Execution **refuses to run without a `decision_id`** — the store-boundary check exists to keep this true as the code grows.
- The tool runs **only** through the execution runtime; no direct `child_process` elsewhere in `src/`. Enforced by a check, not by review.
- `denied` is not `error`. A denial is a policy outcome fed back to the model as information; an error is the tool failing.
- Every invocation records its **effect class** and, for effectful calls, its **idempotency key** — a repeated key is a replay, not a second execution.
- Every invocation records its **declared network class**, even though nothing enforces it ([04-…](04-filesystem-process-network-boundaries.md) §3).

## 7. The v0.1 tool set — four tools, deliberately

| Tool | Effect class | Why it is in the first set |
|---|---|---|
| `read_file` | `read_only` | The only way to see the workspace's real state |
| `write_file` | `local_reversible` | Produces an artifact inside the workspace |
| `run_script` | varies by script, default `local_reversible` | Proves the loop can *do* something and return a result |
| `git_local` | `local_reversible` | Exercises a real multi-step tool with its own internal state, inside a disposable repo |

**ESR — what is excluded and why:** no network tool (unenforcceable, OQ-TM-2), no deletion tool (`local_irreversible` needs the approval path that does not exist yet), no shell tool (an unrestricted shell is the thing the containment exists to avoid), no package installation (writes outside the workspace plus a network need).

## 8. Cancellation hook-up

The contract in [01-cancellation-semantics.md](01-cancellation-semantics.md) applies unchanged; the only addition here is where it attaches: the controller owns the job handle for the task's lifetime, the cancellation request closes admission **before** anything is killed, and the terminal record is written **before** the kill so a crash cannot erase the intent.

## 9. Failure handling

| Failure | Behaviour | State |
|---|---|---|
| Model unavailable / digest mismatch | refuse before any task work | `failed` with `model.refused` |
| Approval required, none arrives | `deny_indeterminate`; never auto-retried | `failed` with that distinct reason |
| Tool denied | recorded; fed back to the model; the task may continue | unchanged |
| Tool crashes | `status: error`; retry only per the effect class and with the key | unchanged or `failed` |
| Context budget exceeded | refusal recorded; **no** truncation | `failed` with `context.refused` |
| Store unavailable | the action does not proceed (fail-closed) | `failed` with `store.unavailable` |
| Process killed mid-task | nothing in flight can be proven | `indeterminate` until reconciled |
| Cancellation incomplete | survivors recorded | `cancel_failed` |

## 10. Acceptance tests

| ID | Test | Positive control |
|---|---|---|
| AT-M2-01 | Task with no checkable criterion is not admitted, 0 model calls | a task with one criterion is admitted |
| AT-M2-02 | End-to-end task with one `write_file` call → `completed` with evidence | the same task with a failing criterion → `failed` |
| AT-M2-03 | Result claiming success with empty `evidence[]` cannot reach `completed` | a result with evidence does |
| AT-M2-04 | Capability widening mid-task is refused and recorded | a request inside the granted set is allowed |
| AT-M2-05 | Execution refuses to run without a `decision_id` | a recorded decision allows execution |
| AT-M2-06 | Context over budget refuses and records; no truncation | a task within budget runs |
| AT-M2-07 | Kill mid-loop → `indeterminate`, no fabricated completion | a graceful run completes |
| AT-M2-08 | Cancellation: 0 surviving processes, verified | a normal task leaves 0 processes |
| AT-M2-09 | `deny_indeterminate` is not retried | a user `deny` may be re-requested after a change |
| AT-M2-10 | Store unwritable → the action does not proceed | a writable store allows the action |

## 11. Open questions

| # | Question | Blocks |
|---|---|---|
| OQ-M2-1 | Is one tool call per turn a hard rule (as the slice states) or a configurable ceiling? | Loop design |
| OQ-M2-2 | Is `git_local` worth its complexity in v0.1, or does `run_script` cover the same ground? | The four-tool set |
| OQ-M2-3 | Does the first slice require an approval prompt UI, or is CLI text sufficient? | Whether `require_approval` is reachable at all |
| OQ-M2-4 | What is the one task, concretely, that v0.1 must be able to do end to end? | The acceptance test that matters most |
