# Phase 5 — Agents and Orchestration: Architecture Specification

**Status:** Research and proposal. **Nothing here is an accepted decision.**
**Audited base revision:** `36a3e18003ad41171be96d28cfbbda5b5304441c`
**Predecessor:** `docs/research/phase-4-documentation-audit/00-documentation-audit.md` (F-2.3, F-2.4, F-5.2 constrain this phase)
**Classification labels:** EUR = explicit user requirement · EAD = existing accepted decision · ESR = evidence-supported recommendation · UAP = unapproved proposal · UNV = unverified assumption · HIS = historical · OQ = open question.

---

## 0. Foundation: what actually constrains this design

Designing multi-agent orchestration before stating the substrate produces the standard failure: an architecture that assumes ten concurrent model sessions on hardware that can run one. The measured substrate, taken from the audit archive and re-measured where noted:

| Constraint | Value | Source | Consequence for orchestration |
|---|---|---|---|
| CPU | Intel i5-7500, **4 cores / 4 logical, no SMT** | `.lain-audit/20-p0-preparation.md` §6; re-measured 2026-11-08 | At most ~4 concurrent subprocesses; model inference is CPU-bound when CPU-offloaded |
| GPU / VRAM | RTX 3050, 6 144 MiB total; **835 MiB idle → ~5 300 MiB free** measured; 655 MiB used at audit time | §6; re-measured | **One local model resident at a time.** Two agents "each with their own model" is not available. |
| RAM | ~15.9 GiB, of which roughly 10 GiB is already committed by the desktop | §6 | Agent state must be in SQLite, not in memory per agent |
| Context | ~4 096-token working window measured feasible for the pinned small model | §5/G-5 (396 tokens system+schemas+task; 618 with a tool result = 15.1 %) | Context is the scarcest resource. Every design below optimises tokens, not wall-clock. |
| Cost | $0-first; unknown pricing **fails closed** | EUR (`DECISIONS.md` ADR-005) | No paid fallback, no trial-credit routing, no "just use the big API" escape hatch |
| Currency of work | `main` is **3 commits ahead of `origin/main`**, unpushed | verified 2026-11-08 | Multi-agent work must be reconstructible from local state alone |
| Isolation | Low-integrity token + MIC: **9/11 escape classes contained, 2 untestable**, not a boundary against a determined local process | `.lain-audit/21-p0-e3-e5-results.md` | "Sandboxed agent" means *contained workspace*, not *untrusted-code-safe* |
| Dependencies | Minimal; no distributed-system complexity | EUR (`DECISIONS.md` ADR-006, Proposed) | Event bus + SQLite + one process. No message broker, no actor framework, no RPC mesh. |

**The single most important design consequence (ESR).** On this machine, **multi-agent does not mean multi-model-in-parallel.** It means: one model call in flight at a time, with agent work overlapping *tool* execution and *human* time — plus strict admission control so that the number of live agents is bounded by resources rather than by ambition. Any orchestration design that assumes N concurrent model calls is unimplementable here and must be rejected at design time, not discovered at implementation time.

---

## 1. Agent architecture

### 1.1 The classification rule that prevents agent-type inflation

The brief lists eleven candidate agent kinds (main/orchestrator, specialist, general-purpose, temporary, persistent, independent reviewer, research, engineering, creative, business) and warns: *"Avoid creating unnecessary agent types merely for organizational appearance."* Those eleven candidates mix three different things — a **lifecycle**, a **job title**, and an **authority level**.

**ESR — the rule:** a distinct agent *type* is justified only when it differs from another type on at least one of these three axes. A difference that lives only in a system prompt is a **preset** of an existing type, not a new type.

| Axis | Question it answers | Example of a real difference |
|---|---|---|
| **Lifecycle** | How long does the instance live, and what owns its state? | orchestrator (session-long) vs task agent (dies with the task) |
| **Authority** | Can it approve its own or another's work? What capability set is it admitted with? | worker (no approval) vs approval path (Policy Engine + human) |
| **Context** | What may it read, and what is it isolated from? | reviewer (must not inherit the author's context) vs author |

### 1.2 The four agent types (ESR, UAP)

I propose **four** runtime types, down from eleven names:

| # | Type | Lifecycle | Authority | Context | Maps to the brief's names |
|---|---|---|---|---|---|
| 1 | **Orchestrator** | One per session; persists across tasks; owns the objective | May decompose, delegate, reassign, cancel; **may not approve** | Full session state (that is its job) | main agent, general-purpose |
| 2 | **Task agent** | Spawned for one task; dies on completion or cancellation; state = the task record | No approval; capability set = task contract ∩ policy | Scoped bundle only (§4.3) | temporary, specialist, research, engineering, creative, business — *by preset* |
| 3 | **Reviewer** | Spawned for one review; dies on verdict | May **reject**; may not approve, and may not modify the artifact | Deliberately blinded to the author's reasoning (§7.4) | independent reviewer |
| 4 | **Persistent specialist** | Outlives tasks; accumulates a durable role memory | No approval | Its own durable memory + task bundles | persistent agents, "agent identity" |

And one deliberately **not** a type: the **long-running tool/job**. A background process that reports a result is a *tool* with a durable job record, not an agent. Modelling background work as an agent is the most common source of agent-count inflation; a job has no objective, no context window, and no judgement, so it must not be modelled as one.

**Explicitly rejected (with reasons, because rejecting is the value of this section):**

| Rejected concept | Why |
|---|---|
| "Creative agent" as a type | Differs only by prompt and tool set → preset. |
| "Business agent" as a type | Same; and its *external actions* are constrained by the approval model (§7), which is orthogonal to agent type. |
| "Agent identity" as a cryptographic or signed entity | No trust boundary in a single-user, single-machine, single-process system justifies it. Identity = `agent_id` in the log. Revisit only if remote/multi-user arrives (currently deferred, `DECISIONS.md` open list). |
| Agent-to-agent negotiation protocols (contract net, auctions) | Optimises for a market of self-interested agents. Here there is one principal and one objective; a scheduler with a priority function dominates. |
| Swarms | The brief explicitly excludes swarms from the first release, and the hardware forbids concurrent model calls. |

### 1.3 Agent record (what is durable)

Every agent instance is a record, not an in-memory object (ESR):

```
agent_id            stable id
type                orchestrator | task_agent | reviewer | persistent_specialist
parent_agent_id     who spawned it (nullable for orchestrator)
task_id             what it is working on (nullable for persistent)
preset              prompt/tool profile name (NOT a type)
capabilities        granted set, fixed at spawn (ADR-004: authorization outside the model)
model_binding       provider+model id pinned by digest, or "inherit"
budgets             turns, tokens, wall_time, model_calls, disk_writes
lifecycle_state     created → admitted → running → {completed | failed | cancelled | blocked}
context_ref         pointer to the scoped bundle (not a copy of it)
```

**ESR — capability immutability.** An agent's capability set is fixed when it is admitted and **cannot be widened by any agent-side message**, including its own request. Widening requires a new admission decision and, for sensitive capabilities, explicit human approval. This is the concrete mechanism behind ADR-004 and it is the cheapest possible implementation of it: capabilities live in the record, and the record is written by the Core, not by the agent.

### 1.4 Agent lifecycle states and legal transitions (ESR)

```
        created
           |  admission control (resources + policy + budget available)
           v
        admitted ------------------------------+
           |  first model call                  | denied → never runs (recorded)
           v                                    |
        running --(task complete, evidence)--> completed
           |  \--(unrecoverable error)-------> failed
           |  \--(budget exhausted)----------> blocked  (checkpointed)
           |  \--(human cancel / shutdown)---> cancelled
           |  \--(dependency unsatisfiable)---> blocked
           v
        cancelled / completed / failed / blocked  →  retained for audit, never silently deleted
```

**ESR — no orphan states.** Every agent instance ends in exactly one of `completed | failed | cancelled | blocked`, and each terminal transition writes one event. An agent whose process died without a terminal event is **indeterminate**, and indeterminate is a first-class recorded outcome (§7.5), not an error to be hidden.

---

## 2. Delegation and orchestration

### 2.1 The task contract — the single most reused artifact in the system

Every unit of delegated work is one **task contract**. It is the interface between the orchestrator (which owns intent) and the task agent (which owns execution), and it must be complete enough that the agent needs **no conversation history** to start. (ESR)

```
task_id                     stable
objective                   one sentence, testable
acceptance_criteria         list of checkable conditions   <-- required, not optional
deliverable                 what artifact/answer is expected, and where it goes
scope_in                    files/paths/domains it may touch
scope_out                   explicit non-goals
inputs                      pointers: file paths, event ids, task ids, prior results  (never transcripts)
capabilities_requested      the minimum set needed (least privilege, enforced at admission)
budgets                     turns, tokens, model_calls, wall_time, disk_writes
dependencies                task ids that must complete first
evidence_required           what must be attached to the result to make it checkable
report_format               the structured result schema (§4.2)
parent_task_id              for decomposition lineage
owner_agent_id              exactly one owner at a time
status                      pending → ready → running → {completed|failed|blocked|cancelled}
```

**ESR — the acceptance-criteria invariant.** A task contract without checkable acceptance criteria may be created as `pending` but **may not be admitted to run**. This is the cheapest anti-goal-drift mechanism available: it forces the orchestrator to state what "done" means before spending a single token, and it makes the reviewer's job mechanical instead of interpretive.

### 2.2 Decomposition and delegation flow

```
USER OBJECTIVE
     |
     v
[Orchestrator] --decompose--> tasks (DAG)  --admission control--> runnable set
     |                              |                                   |
     |                       dependencies                        [Task agents]
     |                                                              |
     |<------------- structured results + evidence ------------------|
     |                                                              |
     |--review request--> [Reviewer (blinded, separate model if available)]
     |                          |
     |<---- accept | reject ----+
     |
     |--aggregate + verify--> USER-FACING RESULT with provenance
```

**ESR — the orchestrator never loses the objective.** Three mechanisms enforce it, and all three are cheap:

1. The orchestrator holds the **only** copy of the user objective; task agents receive a *derived* objective only.
2. Every aggregation step re-checks each result against the original acceptance criteria — not against the agent's claim that it succeeded.
3. **Depth limit of 2** (orchestrator → task agent). A task agent may not spawn sub-agents; if work needs decomposition beyond depth 2, it returns `needs_decomposition` and the orchestrator does it. This bounds the fan-out explosion that otherwise turns into an unreviewable tree.

### 2.3 Selection

**ESR — selection is deterministic, then scored; never LLM-decided.**

| Stage | Rule |
|---|---|
| Hard filters (pass/fail, no scores) | required capabilities ⊆ granted capability set · model supports the required tool-call/structured-output mode · provider is $0-verified and pricing known · context window ≥ estimated need · budget available |
| Then scoring | relevance, measured effectiveness on comparable tasks (from the Evaluation Lab), latency, resource cost, reliability |
| Tie-break | cheapest resource cost, then most recently validated |

**Why deterministic-first matters (ESR, and it is a security property, not a performance one):** a model that *chooses its own executor* can choose an executor with capabilities it was not granted, or route itself to a provider that costs money. Hard filters outside the model make both impossible. This is the ADR-004 pattern applied to routing.

### 2.4 Dependency tracking and deadlock prevention

**ESR:** dependencies form a DAG with these rules:

- **Cycle rejection at creation.** A task whose dependencies would create a cycle is rejected at creation with `dependency_cycle` — never detected at runtime, because a runtime cycle costs a budget and a stuck agent.
- **Readiness is derived, never stored.** `ready = all(dependencies completed)`. A stored "ready" flag is a second source of truth and will drift.
- **Blocked is not dead.** A task with an unsatisfiable dependency becomes `blocked` with a checkpoint and a reason; unrelated tasks continue (this is the "bounded continuation" concept in the repository, and it belongs here, in the Task Manager, not in a new service).
- **Deadlock impossibility by construction:** because cycles are rejected and there is no resource-wait edge between tasks *except* the single inference queue, a cycle of waiting tasks cannot form. The one real wait-edge — the model queue — is bounded by a timeout, so a waiting task cannot wait forever (ESR).
- **Orphan detection:** a task whose `owner_agent_id` points at a terminal agent, and which is not terminal itself, is an orphan → requeued or failed. This is a periodic invariant check, not a reactive one.

### 2.5 Cancellation, retry, and the idempotency rule

**ESR — cancellation is a cascade, not a flag.** Cancelling a task must: (1) set the record terminal, (2) cancel dependent tasks or re-derive their readiness, (3) terminate **the whole process tree** of every tool it started (on Windows this requires a Job Object with kill-on-close — killing a parent does not kill children, which is audit defect S-5), (4) write the terminal event, (5) verify no orphan processes remain.

**ESR — retry is bounded by an idempotency rule.** Every task declares its **external effects**: `none | local_reversible | local_irreversible | external`. Retry policy follows the declaration:

| Effect class | Retry permitted | Why |
|---|---|---|
| `none` (pure reasoning/read) | yes, up to budget | No side effects. |
| `local_reversible` (workspace writes) | yes, after restoring the checkpoint | Journal + checkpoint makes replay safe. |
| `local_irreversible` (deletes, migrations, force-writes) | **only with explicit approval** | Replay may not be possible. |
| `external` (network post, publish, pay) | **never automatic** | Out of scope for v0.1 and out of scope for retry. |

Every effectful operation carries an idempotency key recorded in the event log; a repeated key is a **replay**, not a duplicate execution. This is one sentence of policy that prevents the entire class of "the agent did it twice" bugs.

### 2.6 Reassignment, conflict, and independent review

- **Reassignment (ESR):** allowed only for tasks in `pending | ready | blocked`. A `running` task is cancelled first, never stolen — a stolen task has two owners and therefore two truths.
- **Conflict resolution (ESR):** when two agents disagree, the artifact is what counts. A conflict is resolved by evidence attached to a result, then by re-running the acceptance check, and only then by a human decision. Never by majority vote among agents, and never by the orchestrator simply preferring one agent's prose.
- **Independent review (ESR):** the reviewer (type 3) is a **separate agent instance**, blinded to the author's chain of reasoning, receiving only the artifact, the acceptance criteria, and the evidence. Where the hardware permits a second model, review uses a **different model**; where it does not, review uses a **different prompt, a fresh context, and a checklist** — and the record must state which of the two happened, because a same-model review is weaker evidence and must not be reported as strong.
- **Review outcomes (ESR, resolving open question F-5.2 in part):** `accept | reject | needs_evidence`. A rejection returns the task to `running` with the reviewer's reasons attached; a second rejection of the same task by a different reviewer escalates to human decision. **A task cannot reach `completed` while an open rejection exists** — that is the rule the repository was missing.

---

## 3. Scheduling and resource management

### 3.1 The model queue is the bottleneck, and it is serial

**ESR.** Exactly one model call executes at a time per local provider, enforced by a single-writer queue with a timeout. Consequences that must be designed for, not discovered:

- **Agent parallelism ≠ model parallelism.** N live agents do not give N× throughput; they give N× context cost and 1× model throughput. Therefore **admission control gates on the queue's expected wait**, not merely on "is a slot free".
- **Model swapping is a first-class cost.** Loading/unloading a 4B model costs seconds and VRAM churn; a schedule that alternates models per task will spend its time loading. **ESR: batch by model** — the scheduler groups ready tasks by model binding so the resident model is reused.
- **Reads are free, tokens are not.** Parallelism is useful for tool execution, file I/O, and human interaction. It is *negative* for inference.

### 3.2 Concurrency limits (ESR, derived from measurement)

| Resource | Limit | Derivation |
|---|---|---|
| Concurrent model calls (local) | **1** | VRAM allows one resident model; measured free VRAM ~5.3 GiB |
| Concurrent tool subprocesses | **min(4, cores − 1) = 3** | 4 cores, no SMT; reserve one core for the Core/UI so cancellation stays responsive |
| Live task agents | **4** | Bounded by tool concurrency; more agents than that only queue |
| Live reviewers | **1**, and it is serialised behind the model queue | Review needs the model; a second reviewer does not add throughput |
| Nested delegation depth | **2** | §2.2 |
| Background jobs | **unbounded in count, bounded in resource budget** | Jobs are I/O-bound tools; each declares a budget, and the scheduler admits only while the aggregate budget holds |

**ESR — aggregate budget, not per-item budget.** A per-task budget is not enough: four tasks each within their own RAM budget can still exhaust the machine. The admission controller therefore tracks **aggregate** CPU**, RAM, disk-write and model-queue utilisation, and refuses admission that would exceed the aggregate ceiling. Refusal is recorded with the reason — a refusal is evidence, not silence.

### 3.3 VRAM and model-unloading policy

**ESR.** Model lifecycle is explicit state, not an inference: `unloaded → loading → resident → draining → unloaded`, with one resident model at a time. Before any model load, the scheduler checks free VRAM against the model's *measured* requirement (from the Evaluation Lab/Hardware Intelligence, not from a vendor table). If free VRAM is insufficient, the policy is: **unload the current model, wait, retry once, then fail closed with a recorded reason** — never silently downgrade to a smaller model, because a silent model change invalidates comparability of every result.

### 3.4 Priority, interruption, pause, resume

**ESR.** A single priority function with explicit inputs — human-initiated above agent-initiated; blocking-dependency above standalone; interactive above background; then oldest-first to prevent starvation. **Human interruption outranks every priority**, and its semantics are: stop admitting, cancel the running model call at the next safe boundary, checkpoint running tasks, then report exactly which tasks are indeterminate. Pause/resume is checkpoint-based: resume re-derives readiness and never restores in-flight model state (a half-finished model call is discarded, not resumed).

### 3.5 Context-window awareness as a scheduling input

**ESR.** The scheduler treats context as a consumable with a hard budget per agent, estimated *before* admission. An agent whose scoped bundle plus expected tool output exceeds its window must either be split into smaller tasks or given a summarisation step — the scheduler refuses admission rather than allowing a mid-task overflow. On a 4 096-token window, an overflow is not a slowdown; it is a failed task.

---

## 4. Agent communication

### 4.1 Message kinds and their contracts (ESR)

Nine kinds, each with a schema, a required evidence field, and an explicit "what the receiver may assume":

| Kind | Direction | Required content | Receiver may assume |
|---|---|---|---|
| `handoff` | orchestrator → agent | the full task contract (§2.1) | nothing beyond the contract |
| `progress` | agent → orchestrator | task_id, step, % derived from completed steps, tokens spent | informational only; never a completion claim |
| `question` | agent → orchestrator | the blocking question, the options, the default if unanswered | an unanswered question does **not** authorise a guess on an irreversible action |
| `blocker` | agent → orchestrator | what is blocked, what was tried, what would unblock it | must be recorded as `blocked`, never as `failed` silently |
| `review_request` | orchestrator → reviewer | artifact pointer + acceptance criteria + evidence | the reviewer may not read the author's reasoning |
| `review_result` | reviewer → orchestrator | accept/reject/needs_evidence + reasons + counter-evidence | a rejection is binding on task completion |
| `result` | agent → orchestrator | the report schema (§4.2) + evidence pointers | claims are **unverified** until checked |
| `cancellation` | orchestrator → agent | reason, deadline for acknowledgement | the agent must stop and report what it did |
| `notification` | any → log | anything else, non-actionable | no authority whatsoever |

### 4.2 The structured result — why "the model said it worked" is not evidence

**ESR.** Every task result has a fixed schema:

```
task_id, agent_id, status (completed|failed|blocked|cancelled|indeterminate)
claims[]           what the agent asserts it did          (unverified by definition)
artifacts[]        paths + content hashes of what it produced
evidence[]         commands actually run + their observed exit codes/output tails
checks[]           which acceptance criteria were verified, and by what
not_verified[]     what it could not check and why         <-- required field, may be empty but must be explicit
indeterminate[]    effects that may or may not have happened
tokens, model_calls, wall_time
```

**ESR — the asymmetry rule.** An agent's claim is *never* sufficient; an agent's **evidence** may be. This single rule is what converts "the model said it worked" into "the log says it happened", and it is why `not_verified[]` and `indeterminate[]` are mandatory fields rather than optional courtesies.

### 4.3 Context handoff without transcript copying

**ESR.** A handoff passes **pointers, budgets and criteria** — never a transcript:

| Passed | Not passed |
|---|---|
| task contract (§2.1) | the orchestrator's conversation history |
| file paths, event ids, task ids, artifact hashes | file *contents* (the agent reads them) |
| the acceptance criteria and report schema | the reasoning that produced the criteria |
| the pinned model binding and capability set | other agents' context |

Rationale (ESR): copied transcripts are the largest avoidable token cost in any multi-agent system, they leak one agent's errors into another's reasoning, and they make the review non-independent. A pointer cannot leak a reasoning chain.

**Measured anchor for why this is not premature optimisation:** a bare agent frame (system + 3 tool schemas) measured 396 tokens, and 618 with one tool result — 15.1 % of a 4 096-token window before any real work. Copying a transcript would consume the remainder.

### 4.4 Durable handoff records

**ESR.** Every handoff and result is written to the event log as its own record, not embedded in a conversation blob. Consequence: a crashed session resumes by reading **records** (`SELECT ... WHERE status='running'` plus their last checkpoint), not by re-reading a chat. This is what makes recovery possible without a model in the loop — and it is why the event log's ownership question (Phase 4 F-2.3) gates this entire phase.

---

## 5. Autonomous execution (bounded autonomy)

### 5.1 The autonomy envelope (ESR)

An agent's freedom is the intersection of five things, all bounded and all recorded before it runs:

```
autonomy = objective ∩ capability set ∩ budget ∩ approval policy ∩ stopping conditions
```

| Bound | Enforced by | Failure mode if missing |
|---|---|---|
| objective | task contract | drift: work that is plausible but not requested |
| capability set | Core at admission (immutable) | escalation by request, or by writing a manifest (Phase 6 F-1.2) |
| budget | scheduler, counted per turn | runaway cost on a machine that cannot afford it |
| approval policy | Policy Engine, outside the model | self-authorisation |
| stopping conditions | task record, checked at each step | work that never ends and never says why |

### 5.2 Checkpoints (ESR)

A checkpoint is written at every **commit point**: a transaction boundary in the store, a completed tool call with verified evidence, a decision that changed the plan, and before/after any `local_irreversible` effect. A checkpoint contains: task status, the plan as currently understood, artifacts with hashes, evidence accumulated, budget consumed, and the next intended step. **A checkpoint is deliberately not a conversation snapshot** — it is the minimum needed to resume *and to explain*.

### 5.3 Approval gates (ESR)

Gates are decided **outside the model** and are the same categories the security model already names:

| Gate | Examples | Default on timeout |
|---|---|---|
| Reversible local action inside scope | workspace file writes, reads, builds | **allow** (already authorised by scope) |
| Irreversible local action | delete, overwrite outside scope, migration, force-write | **deny** |
| New permission / capability widening | network, new credential, new path root | **deny** |
| External or financial action | publish, post, purchase, contract, account change | **deny** |
| Security/governance change | policy edit, trust level, audit config | **deny, and segregation of duties** |

**ESR — the timeout rule.** Absence of approval is denial. A timeout is `DenyIndeterminate`, which is **not** the same as a user's explicit "no": an agent may re-ask after a user "no" with new evidence, but may **never** retry after an indeterminate timeout. "Wait forever" is not a supported value.

### 5.4 Stopping conditions (ESR)

An agent stops when **any** holds, and the reason is recorded in every case: objective met and evidence attached · budget exhausted · the same failure repeated twice (fail fast, do not loop) · a decision is required that the agent is not authorised to make · cancellation received · approval denied or indeterminate · acceptance criteria proven unsatisfiable by evidence. **An agent that stops without recording why has failed, not finished.**

---

## 6. Failure and recovery strategy

| # | Failure | Detection | Response (ESR) | Never do |
|---|---|---|---|---|
| F-1 | Model returns malformed tool call | schema validation before execution | 1 constrained retry with a repair prompt, then count against budget and fail the step | Execute a partially-parsed call |
| F-2 | Tool fails | exit code + stderr captured | classify (transient/input/permanent); retry only transient, max 2 | Retry a permanent failure to look busy |
| F-3 | Tool hangs | per-call timeout | kill the **process tree** (Job Object), record `timeout`, mark the step failed | Leave the child running (S-5) |
| F-4 | Agent process dies mid-task | heartbeat + missing terminal event | task → `indeterminate`, effects from the last checkpoint are re-derivable; **any effect after the last checkpoint is marked indeterminate and is not silently re-run** | Assume it did nothing, or assume it finished |
| F-5 | Cancellation leaves children | process-tree enumeration post-cancel | kill tree, verify count zero, record the verification | Report "cancelled" without verifying |
| F-6 | Two agents contend for a write | single-writer rule + ownership check | second writer refused; contention recorded | Last-writer-wins |
| F-7 | Dependency cycle | cycle check at creation | reject at creation | Detect at runtime |
| F-8 | Reviewer rejects repeatedly | rejection counter | second rejection by a different reviewer → human decision; task stays open | Complete the task anyway |
| F-9 | Context overflow mid-task | estimated pre-admission; token counter during | stop, checkpoint, return `needs_decomposition` | Silently truncate context |
| F-10 | Insufficient VRAM for the pinned model | pre-load check | unload → wait → retry once → fail closed **with the reason** | Silently switch to a smaller model |
| F-11 | Provider rate limit / unavailable | response status | back off, requeue once, then `blocked` with reason | Fall back to a paid provider (ADR-005) |
| F-12 | Secret detected in an event payload | store-level redaction filter on write | redact before persist; **never** write and clean later | Log then scrub (append-only makes it permanent) |
| F-13 | Prompt injection via tool output or another agent's result | content classification at the boundary | treat all agent/tool content as **untrusted data**; it can never grant a capability or approve an action | Trust a result because it came from "our" agent |
| F-14 | Orphan task (owner terminal, task not) | periodic invariant sweep | requeue or fail with reason | Leave it "running" forever |

**ESR — recovery is evidence-based, not optimistic.** The recovery rule in one line: **on restart, every effect that cannot be proven from the log is marked indeterminate and surfaced to the user.** Re-running indeterminate work is an explicit decision, never a startup side effect.

---

## 7. Security and permission requirements

1. **Authorization is external to every agent (EAD, ADR-004).** Agents propose; the Policy Engine disposes. An agent's own statement of what it is allowed to do carries zero weight.
2. **Capabilities are granted at admission, immutable for the instance's lifetime (ESR).** Widening requires a new admission decision.
3. **Handoff messages grant nothing (ESR).** A task contract is a request for work, not a permission. A message from the orchestrator cannot widen a capability set, and this must be enforced structurally (the field is not writable by any agent path).
4. **Agent-to-agent content is untrusted input (ESR).** F-13: the same prompt-injection posture applied to a web page applies to another agent's result. This is the security consequence of multi-agent design that single-agent designs never face.
5. **Segregation of duties (ESR).** The author cannot review its own artifact; the reviewer cannot modify the artifact; the orchestrator cannot approve its own escalation. Three separate identities, three separate paths, all recorded.
6. **Least privilege at spawn (ESR).** The capability set is the intersection of what the task contract requests and what policy permits — requested is an upper bound, never a grant.
7. **Containment is stated honestly (ESR).** Agents' tool execution happens in a contained workspace (low-integrity token + MIC: 9/11 classes contained, 2 untestable, not a boundary against a determined local process). No document may describe this as a sandbox against hostile code.
8. **No secret reaches an agent's context (ESR).** Secrets are resolved by the Core at the point of use; an agent sees a handle, never a value. Combined with F-12, this closes the "secret in an append-only log" hole at both ends.
9. **Every gate denial is recorded with its reason (ESR).** A denial that leaves no trace cannot be audited, cannot be tuned, and cannot be distinguished from a bug.

---

## 8. Orchestration invariants (the checklist an implementation must satisfy)

| # | Invariant | Why it is stated as an invariant |
|---|---|---|
| I-1 | Exactly one agent owns a task at any instant. | Two owners = two truths. |
| I-2 | No task reaches `completed` with an open rejection. | Otherwise review is decorative. |
| I-3 | No task is admitted without checkable acceptance criteria. | Prevents unmeasurable work. |
| I-4 | No capability set changes after admission. | Closes escalation-by-request. |
| I-5 | No effect is retried without an idempotency key. | Closes double-execution. |
| I-6 | No task waits on a resource without a timeout. | Deadlock impossibility. |
| I-7 | Cancellation leaves zero orphan processes, verified. | S-5. |
| I-8 | Every terminal state is recorded; unknown states are `indeterminate`. | Recovery correctness. |
| I-9 | Absence of approval is denial. | ADR-005 applied to approvals. |
| I-10 | One writer per log batch, one transaction per batch. | Measured: 963/1766 torn reads otherwise. |

---

## 9. Acceptance-test plan (thresholds labelled M/D/P)

M = measured on this machine · D = derived from a measured value · P = proposed, must not gate a release without measurement.

| ID | Test | Threshold | Tier |
|---|---|---|---|
| AT-5.01 | Task readiness is derived from dependencies | 100 % of sampled tasks match a recomputed readiness set | D |
| AT-5.02 | Dependency cycles rejected at creation | 0 cycles admitted; every cycle attempt recorded with a reason | D |
| AT-5.03 | Single owner per task under contention | 100 concurrent claim attempts → exactly 1 winner, 0 double-owners | M |
| AT-5.04 | No completion with an open rejection | 0 tasks completed while a rejection is open | D |
| AT-5.05 | Cancellation kills the whole process tree | 0 surviving descendants after cancel, verified by enumeration, 20/20 runs | M |
| AT-5.06 | Admission refuses beyond aggregate budget | 0 admissions granted past the ceiling; every refusal carries a reason | D |
| AT-5.07 | Model calls are serialised per local provider | max concurrent model calls = 1, sampled over a run | M |
| AT-5.08 | Capability immutability | 0 successful widenings from an agent-side message | D |
| AT-5.09 | Approval timeout denies | timeout → `DenyIndeterminate`, never an allow; retry after indeterminate = 0 | D |
| AT-5.10 | Idempotent replay | replayed effect with the same key → 1 execution, 0 duplicates | D |
| AT-5.11 | Crash recovery marks the unprovable | after a hard kill, every unprovable effect appears in `indeterminate[]` | D |
| AT-5.12 | Context handoff contains no transcript | 0 handoff records exceed the token budget for pointers + criteria | P |
| AT-5.13 | Independent review is independent | 0 review records where the reviewer inherited the author's reasoning context | D |
| AT-5.14 | Agent concurrency ceiling respected | live task agents ≤ 4, tool subprocesses ≤ 3, sampled | M |
| AT-5.15 | Every denial is recorded with a reason | 0 denials without a reason field | D |

**ESR — non-vacuity requirement.** Every denial-class test above must be paired with a **positive control** in the same run (the same operation permitted inside its authorisation), because a suite that cannot be exercised reports success when the mechanism is broken. The E3/E5 work established this rule; it applies here unchanged.

---

## 10. Prioritized implementation backlog

Ordered so that each item is *testable when it lands*, and so that nothing is built on the two open blockers (§11).

| # | Item | Depends on | Why here |
|---|---|---|---|
| 1 | **Task contract schema + task record store** | event log owner (Phase 4 C-1) | Everything else references it; it is the interface of the whole phase. |
| 2 | **Single-writer event log with one transaction per batch** | C-1 | Measured: the alternative produced 963 torn reads in 1 766. Non-negotiable and first. |
| 3 | **Admission control (aggregate budget, concurrency caps, refusal reasons)** | 2 | Cheapest place to prevent the machine being oversubscribed. |
| 4 | **Agent record + lifecycle state machine + terminal-state rule** | 1, 2 | Makes agents auditable before they are clever. |
| 5 | **Model queue (serial, timeout, batch-by-model)** | 2 | The real bottleneck; must exist before concurrency does. |
| 6 | **Structured result schema + evidence capture** | 1 | Converts claims into checkable results. |
| 7 | **Delegation + handoff records (pointers only)** | 4, 6 | Enables real delegation without transcript copying. |
| 8 | **Capability grant at admission + immutability enforcement** | 4 | Closes escalation-by-request before any extension work exists. |
| 9 | **Approval gates + timeout→deny + `DenyIndeterminate`** | 8 | Security behaviour, testable in isolation. |
| 10 | **Job Object cancellation (process-tree kill + verification)** | 5 | Fixes S-5; testable with a positive control. |
| 11 | **Checkpoint + resume + indeterminate marking** | 2, 6 | Makes bounded autonomy survivable. |
| 12 | **Independent review path (blinded reviewer, verdict binding)** | 7, 8 | Adds the quality mechanism once the plumbing is honest. |
| 13 | **Priority function + human interruption semantics** | 3, 5 | Needed the moment two tasks compete. |
| 14 | **Failure playbook F-1…F-14 wired to events** | 6, 11 | Turns the table above into behaviour. |
| 15 | **Persistent specialist memory (scoped, provenance-linked)** | 2, 11 | Last: it is the only part that is not required for a working loop. |

**Sequencing rationale (ESR).** Items 1–3 are infrastructure whose absence makes every later item untestable. Items 4–9 build the smallest orchestration that can be *audited*. Items 10–12 make it survivable and reviewable. Items 13–15 are refinements that can be deferred without invalidating anything before them.

---

## 11. Dependencies and blockers for this phase

Per the program's requirement to state readiness precisely rather than assume it:

| Required foundational capability | Exists? | Evidence | Blocking for |
|---|---|---|---|
| Event log with an owner and a single-writer rule | **No** | `SYSTEM_BOUNDARIES.md:8-20` has 11 rows, none for events; "single writer" has 0 occurrences in the canonical tree | **Everything in this phase** |
| Policy Engine contract (`decide()` with a default-deny arm) | **No** | `SYSTEM_BOUNDARIES.md:13` names the owner; no contract anywhere | Items 8, 9, 12 |
| Task Manager (task records, dependencies, status) | **No** | Named at `SYSTEM_BOUNDARIES.md:11`; no schema | Items 1, 7 |
| Execution Runtime (workspace, containment, process control) | **No** | Named at `:15`; containment verified only as a mechanism experiment | Item 10 |
| Model Intelligence / provider abstraction | **No** | Named at `:16`; language/toolchain decision still open (`DECISIONS.md` ADR-011 "Experiment required", and `cargo`/`rustc` are absent while `node` v24.21.0 is present) | Item 5 |
| Session/turn records | **No** | Named at `:10` | Context scoping |
| Retrieval / memory records | **No** | Named at `:17`; Phase 4 is future work in the roadmap | Item 15 |

**Verdict (ESR).** Phase 5 **cannot be implemented today**, and no honest standalone version of it can be built either — an agent runtime without an event log, a task store, and a policy contract is a demo, not a subsystem. What *can* be built independently, and is genuinely useful on its own:

1. The **task contract and result schemas** (pure data definition, testable by validation).
2. The **single-writer event log** with one transaction per batch (this is also the audit's #1 foundation item, and it is independently testable).
3. The **admission-control budget calculator** (pure function over declared budgets — testable without any agent).

Those three are the smallest useful vertical slice, and together they unblock Phase 6, 7 and 8 as well, because every later phase writes tasks, events and results.

---

## 12. Open questions from this phase

| # | Question | Why it needs the user |
|---|---|---|
| OQ-5.1 | Is a second local model permitted resident for independent review, or must review always be same-model? | VRAM: ~5.3 GiB free. Two small models may fit; it changes review strength and must not be guessed. |
| OQ-5.2 | Should `local_irreversible` effects ever be permitted unattended? | Currently: no (approval required). Reversing it is a security decision. |
| OQ-5.3 | Is the 4-agent / 3-subprocess ceiling acceptable as a documented limit, or should it adapt dynamically? | A static ceiling is simpler; a dynamic one needs a measurement loop, i.e. Hardware Intelligence. |
| OQ-5.4 | Terminal state for a twice-rejected task: `failed`, `blocked`, or human-owned? | Affects backlog accounting and reporting semantics. |
| OQ-5.5 | Does "persistent specialist" earn its place in v0.1? | It is the only type whose value depends on cross-task memory, which is deferred. |
