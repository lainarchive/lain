# 06 — `Lain v0.1.0 — One Bounded Agent`: Implementation Specification

**Status:** Proposed specification. **Nothing here is implemented; no model call was made in preparing it.**
**Base revision:** `36a3e18003ad41171be96d28cfbbda5b5304441c`
**Labels:** EUR · EAD · ESG/ESR · UAP · OQ · HIST · P (proposed threshold)
**Scope note (ESR).** This document specifies the **whole** vertical slice, but `07-implementation-sequence.md` splits its delivery: **M-1 is the deterministic foundation** (event store, policy contract, budget, build/check — no model calls at all) and **M-2 adds the model loop**. The split exists because M-1 can be verified completely on this machine today, while M-2 depends on the model-binding and containment measurements that are still open.

---

## 1. The one-sentence definition (EUR, from the revised first-vertical-slice research)

> A command-line program that accepts one task, runs one local model against one contained workspace through one approved tool call at a time, writes everything it does to an append-only event log, and — after a hard kill — can prove exactly what it did and mark anything it cannot prove as indeterminate.

**ESR — why this is the right first slice.** It falsifies the architecture's riskiest assumption (that a ≤ 4 B local model at 4 096 context can reliably drive a tool-calling loop inside an OS-enforced containment boundary) while building the six primitives every later phase reuses. It demonstrates no breadth on purpose: no swarms, no delegation, no plugins, no MCP, no memory graph, no UI, no unattended operation (EAD, ADR-013).

## 2. Prerequisites — each with its state at `36a3e18`

| # | Prerequisite | Exists? | Provided by |
|---|---|---|---|
| P-1 | Reproducible build/check command | **No** | M-1 step 1 (`04-…`) |
| P-2 | Event store with the guarantees in `01-…` | **No** | M-1 step 2 |
| P-3 | Host probe + resource budget | **No** | M-1 step 3 |
| P-4 | Policy decision contract (`decide()`, 8 arms, default Deny) | **No** | M-1 step 4 |
| P-5 | Task contract + task records | **No** | M-1 step 5 |
| P-6 | Model binding (digest-pinned, cost-classified, fail-closed) | **No** | M-2 step 1 |
| P-7 | Contained execution (Low-integrity workspace + Job Object) | **No** (mechanism verified, integration not) | M-2 step 2 |
| P-8 | Tool execution contract | **No** | M-2 step 3 |
| P-9 | Bounded agent loop | **No** | M-2 step 4 |
| P-10 | Cancellation cascade + result recording | **No** | M-2 step 5 |

**ESR — the honest sequencing conclusion:** `P-1 … P-5` are deterministic and testable without a model; `P-6 … P-10` are not. Implementing `P-9` before `P-2` would produce exactly the failure the brief forbids: a simulated capability with no substrate.

## 3. Component interfaces

### 3.1 Task contract (UAP)

```
task {
  task_id              ULID
  objective            text, the user's own words, unmodified
  acceptance_criteria  [ { id, statement, check: {kind:"command"|"artifact"|"assertion",
                                                 spec}, required: bool } ]   >= 1 required
  capabilities         [ capability_id ]        granted at admission; IMMUTABLE thereafter
  workspace            absolute path, resolved once at admission
  budget               { max_model_calls, max_tool_calls, max_wall_ms,
                         max_tokens, max_tool_subprocesses }
  effect_class         none | local_reversible | local_irreversible | external
  parent_task_id       nullable (delegation depth <= 2)
  created_at, created_by
}
task_state { submitted | admitted | running | blocked | reviewing
             | completed | failed | cancelled | indeterminate }
```

**Rules (ESR).** (1) A task with no checkable acceptance criterion is **not admitted** — this is what makes "completed" mean something. (2) Capabilities are fixed at admission; widening requires a **new** admission decision (ADR-004 made structural). (3) `objective` is stored verbatim; paraphrase by a model is a separate field, never the record.

### 3.2 Policy decision contract (UAP)

```
request  { action, target, task_id, requested_capabilities[], effect_class,
           resource_request, prompt_context_digest, requested_by }

decision { outcome:   allow | deny | allow_with_conditions | require_approval
                     | deny_indeterminate | defer
           reason_code, reason, conditions[]?, approval_id?,
           expires_at?, decided_by: "policy@0.1.0", rule_id,
           budget_after, decided_at }
```

**Rules (ESR).** Total — every request produces a decision, never an exception and never a default-allow. The default arm is **`deny`**. `deny_indeterminate` is a **distinct** outcome (an approval that timed out) and is **never retryable**, whereas a user's `deny` may be re-requested after circumstances change (EAD, ADR-004; audit OD-7). The decision is recorded **before** the action, and the action's event carries `decision_id` as `causation_id`. `prompt_context_digest` exists so that a decision can be attributed to the context it was made against — a decision that cannot be tied to its inputs cannot be reviewed.

### 3.3 Model adapter contract (UAP)

```
bind(binding_spec) -> session
binding_spec { protocol: openai_compatible_local | ollama_native
                        | llama_cpp_server | manual_cli
               endpoint, model_id, digest (sha256, REQUIRED),
               context_window, cost_class: free | local | trial
                                        | paid | unknown }
call(session, messages, tool_schemas, params) -> { text?, tool_calls[],
                                                   usage, finish_reason }
```

**Rules (ESR).** A digest mismatch **refuses** to run. `cost_class: unknown` **refuses** to run with a recorded reason (EAD, ADR-005). `paid` refuses unless the user has explicitly enabled that binding for that task. The adapter never decides *whether* a call may happen — it asks policy and reports what happened. **UNVERIFIED:** the exact tool-call conformance of the pinned small model is the P0 spike's question and is **not** assumed by this specification.

### 3.4 Tool execution contract (UAP)

```
invoke(tool_id, args, task_id, capability_grant, workspace) -> result
result { status: ok | error | denied | timeout | partial
         stdout, stderr, exit_code, artifacts[] (paths + digests),
         duration_ms, resource_peak, effect_observed }
```

**Rules (ESR).** Every invocation is preceded by a policy decision and followed by an event carrying both. The tool runs **only** through the execution runtime (no direct `child_process` outside it) — enforced by the boundary check V-8, not by convention. The process tree is owned by a **Job Object** with kill-on-close so cancellation cannot orphan children (the audit's S-5 finding: killing a Windows parent does not kill its children). `result.status` distinguishes `denied` from `error`: a denial is not a failure of the tool.

## 4. State transitions (ESR)

```
submitted --admit(policy: allow)--> admitted
admitted  --start-->               running
running   --need_evidence-->       blocked      (checkpoint written)
blocked   --resume-->              running
running   --review_requested-->    reviewing
reviewing --accept-->              completed    (only if all required checks passed)
reviewing --reject-->              running      (a rejection never leaves a task completed)
reviewing --needs_evidence-->      blocked
running   --check_failed-->        failed
running   --cancel-->              cancelled    (verified cascade)
*         --crash-->               indeterminate (only the store can resolve it)
indeterminate --reconcile-->       running | failed | cancelled
```

**Illegal transitions are refused and recorded**, never silently ignored: `completed` while a rejection is open; `completed` without every `required` check having evidence; any transition that widens `capabilities`; `resume` of a task whose approval expired (that is `deny_indeterminate`).

## 5. The bounded loop (UAP)

```
1  probe host, compute budget, refuse if insufficient       -> host.probed / budget.refused
2  admit task (policy: allow)                               -> task.admitted
3  bind model (digest, cost class) or refuse                -> model.bound | model.refused
4  loop:
     a  build context: system + tool schemas + task + last tool result
        refuse if > context budget (never truncate silently) -> context.refused
     b  model call                                          -> model.called
     c  if tool_calls: policy decide each                   -> policy.decided
        if allow: execute (one at a time), record result     -> tool.executed
        if deny:  record denial, feed the denial back to the model -> tool.denied
     d  if no tool_calls: produce result artifact            -> task.result.proposed
     e  check budget + stopping conditions; stop if exhausted
5  run acceptance checks against the recorded result         -> check.passed | check.failed
6  terminal event with claims/evidence/not_verified/indeterminate
```

**Rules (ESR).** One tool call per turn (EUR, the slice's own definition). Budget exhaustion is a **terminal** outcome with a reason, not a silent stop. The model's own claim of success is never sufficient: `result {claims[], artifacts[], evidence[], checks[], not_verified[], indeterminate[]}` with the asymmetry that **a claim is never sufficient and evidence may be**.

## 6. Cancellation (ESR)

Cancellation is a **verified cascade**, not a flag:
1. Task state → `cancelled` record written **before** killing anything.
2. Job Object killed as a unit (kill-on-close guarantees no orphan survives the parent).
3. Zero-orphan verification: enumerate the process tree; **if any descendant survives, the cancellation is reported as failed**, not as success.
4. Terminal `task.cancelled` event with the surviving-process count.
5. Dependents (none in M-1) would be re-derived rather than cascaded.

**OQ-M1.22:** whether cancellation is *interruptible at a safe point* (allowing a running tool to finish) or *immediate* by default — the audit's S-5 leaves the semantics unspecified, and the choice changes what a cancelled task's artifacts mean.

## 7. Failure handling (ESR)

| Failure | Behaviour |
|---|---|
| Model unavailable / digest mismatch | refuse before any work; `model.refused` with reason; task → `failed` |
| Policy requires approval, none arrives | `deny_indeterminate`; task → `failed` **with that distinct reason**; never retried automatically |
| Tool denied | recorded; the denial is fed back to the model as information; the task may continue within budget |
| Tool crashes | `tool.executed` with `status: error`; retry only if `effect_class` permits (Phase 5 rules); idempotency key on every effectful call |
| Context budget exceeded | refuse the turn, record the refusal, stop the loop with a reason (never truncate) |
| Event store unavailable | **the action does not proceed** (fail-closed rule, `02-…` §1.3) |
| Process killed mid-work | on restart, the task is `indeterminate` until the store's own records resolve it; the agent never guesses |

## 8. Event requirements (ESR)

Every step above names its event type. Minimum set for the slice: `host.probed`, `task.admitted`, `task.state.changed`, `policy.decided`, `model.bound`, `model.called`, `tool.executed`, `tool.denied`, `check.passed`, `check.failed`, `task.result.proposed`, `task.cancelled`, `store.backup.taken`. Each carries `task_id`, `correlation_id`, and (where caused by a decision) `causation_id = decision_id`. **Redaction applies to all of them** — a tool's stdout is exactly the kind of payload that leaks a token.

## 9. Acceptance tests for the slice (P thresholds unless noted)

| ID | Test | Expected |
|---|---|---|
| AT-1BA-01 | Admit a task with no checkable criterion | refused, `task.not_admitted`, 0 model calls (D) |
| AT-1BA-02 | Run a task end-to-end with one tool call | `completed`; every state transition has an event; the tool's artifact digest matches the recorded one |
| AT-1BA-03 | Kill mid-loop; restart | task reported `indeterminate`; no fabricated completion; store contiguity intact |
| AT-1BA-04 | Cancel during a tool call | zero surviving descendants; `task.cancelled` with survivor count 0 |
| AT-1BA-05 | Approval times out | `deny_indeterminate`; task failed with that reason; **no automatic retry** (D) |
| AT-1BA-06 | Tool denied by policy | denial recorded and fed back; no execution attempt occurs |
| AT-1BA-07 | Context budget exceeded | refusal recorded; **no** silent truncation (D) |
| AT-1BA-08 | Store made unwritable | the action does not proceed; refusal recorded (D) |
| AT-1BA-09 | Model digest mismatch | refusal before any task work |
| AT-1BA-10 | Unknown cost class | refusal with recorded reason (D) |
| AT-1BA-11 | Result claims success with no evidence | `completed` is **not** reachable; the result lists the claim under `not_verified` (D) |
| AT-1BA-12 | Positive controls (mandatory) | a compliant task **does** complete; an allowed tool **does** execute; an in-budget context **is** accepted |

## 10. Open questions

| # | Question | Blocks |
|---|---|---|
| OQ-M1.22 | Cancellation semantics: immediate vs safe-point (see §6) | tool execution design |
| OQ-M1.23 | Is the pinned `qwen3-4b-instruct-2507` binding (digest `1a2c1c9c3f3b…`) accepted for M-2, and is the P0 spike's tool-call verdict a precondition? | M-2 start |
| OQ-M1.24 | Is one tool call per turn a hard v0.1 rule (as the slice states) or a configurable ceiling? | loop design |
| OQ-M1.25 | Does the first release allow any `local_irreversible` effect unattended? (Phase 5 §9 asks the same question.) | policy arm coverage |
