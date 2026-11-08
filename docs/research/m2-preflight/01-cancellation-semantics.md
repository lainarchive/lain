# 01 — Cancellation Semantics (D-V1)

**Status:** DECIDED BY EVIDENCE where evidence exists; RECOMMENDED where it does not. **No M-2 code was written.**
**Date:** 2026-11-08
**Scope:** the cancellation contract for the first bounded agent — what cancellation means per effect class, the lifecycle, legal and illegal transitions, and the acceptance criteria. Does not implement anything.
**Verification classification:** VERIFIED (store behaviour, measured here) · HISTORICAL (Phase 5 research, `.lain-audit` findings) · PROPOSED/RECOMMENDED (the model below) · NOT-TESTABLE (anything requiring the M-2 runtime).
**Depends on:** [01-event-store-specification.md](../m1-foundation-readiness/01-event-store-specification.md), the M-1 store at `src/store/`, [00-agents-orchestration-specification.md](../phase-5-agents-orchestration/00-agents-orchestration-specification.md) §2.5, [06-one-bounded-agent-specification.md](../m1-foundation-readiness/06-one-bounded-agent-specification.md) §6.

---

## 1. What the existing implementation already decides — VERIFIED

Three measured facts constrain the model, and none of them is negotiable because they are properties of what is built:

1. **A batch is atomic and committed per `append()`.** `appendMany` validates every draft before writing any, inserts inside one transaction, commits, and only then re-acquires the write lock ([`src/store/index.mjs:225-248`](../../../src/store/index.mjs)). So a cancellation that lands mid-batch either happens before the commit (nothing is written) or after it (the whole batch is durable). **There is no partial batch to cancel.**
2. **Losing the writer lock is a first-class outcome, not an error to retry blindly.** `STORE_LOCK_LOST` is thrown with `committed_through_seq` in the detail, and the handle stops being a writer. A cancellation path that swallows this and keeps appending would produce exactly the unauditable gap the store exists to prevent.
3. **The terminal record can be written before any kill, and that ordering is enforceable**, because the store is independent of the process being killed.

Everything below follows from those three, plus the Phase 5 rule that retry is governed by a declared effect class (HISTORICAL: `00-agents-orchestration-specification.md:184-193`).

## 2. The three candidate models, compared

| Dimension | A. Immediate | B. Safe-point | C. Hybrid by effect class |
|---|---|---|---|
| **Response latency** | Bounded by one `TerminateProcess` (ms). Fastest, and the only model whose latency does not depend on what the tool is doing. | Bounded by the length of the current tool call. On a 4-core machine with a 300 s tool timeout, "cancel" can mean five minutes of continued writes. | Per class: `none`/`local_reversible` as A, `local_irreversible` as B with a deadline, `external` never automatic. |
| **Transaction integrity** | Unaffected either way — the store's transaction is in the controller, not in the child. VERIFIED by the store's own recovery tests (AT-M1-14: an abandoned `BEGIN IMMEDIATE` leaves no partial batch). | Same. | Same. |
| **Child-process behaviour** | Tree killed as a unit by the Job Object; no cooperation required from the child, which matters because a tool cannot be trusted to honour a cooperative stop. | A cooperative stop needs cooperation the child may not provide — and a hostile or simply buggy tool will not. | Uses A where cooperation is unnecessary and B only where an abrupt stop would destroy value. |
| **Tool side effects** | An effectful tool may be killed between "did the thing" and "recorded the thing" — the classic indeterminate outcome. | The effect completes; what is avoided is the half-written artifact. | The classification decides which risk is acceptable, per operation rather than per system. |
| **Partial results** | A killed child may leave a partial artifact. If the artifact is declared, that is `indeterminate[]`, not loss. | The current step finishes and its result is recorded before the stop. | Same, but only for the classes that need it. |
| **Cleanup** | None required from the child; the controller removes the workspace per policy. | The child may be asked to clean up, which is untrusted work. | Controller-owned cleanup in both cases. |
| **Orphan-process risk** | Lowest **if and only if** the Job Object owns the tree with no breakaway flags. Docs: a process not in a job with `JOB_OBJECT_LIMIT_BREAKAWAY_OK` produces children in the job by default; setting neither breakaway flag prevents breakaway entirely ([Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects), [nested jobs](https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs)). | Same mechanism, but a longer window in which the tree is alive. | Same, with a longer window only for `local_irreversible`. |
| **Idempotency** | An interrupted effect needs an idempotency key to be safely retried at all. | Retry safety is the same; the probability of a torn effect is lower. | Keys are required for every effectful call regardless of model. |
| **Retry safety** | A torn `local_irreversible` effect must **never** be retried automatically. | A completed `local_irreversible` effect may be; a timed-out one may not. | Per class and per declared key. |
| **Audit events** | Request, acknowledgement, kill, verification, terminal — five events, all writable before the kill except the last. | Same, plus a `tool.safe_point.reached` event. | Same. |
| **Resource consumption** | Reclaims CPU/VRAM immediately. | Holds resources for the duration of the current call. On this machine (4 threads, one resident model) that matters. | Between the two. |
| **Windows complexity** | Needs a Job Object handle held by the controller for the whole task lifetime. Moderate and already prototyped in the Phase 0 E4 plan. | Needs the same Job Object **plus** a cooperative protocol the child may ignore. Strictly more. | The union of A's and B's mechanisms, no new mechanism. |
| **Failure recovery** | Simplest to reason about: after a cancel, every unfinished effect is `indeterminate[]`. | Ambiguity moves inside the tool: "did it finish before the safe point?" | Explicit and per class. |

**PROPOSED — Model C is recommended**, and the reason is narrower than "it sounds best": A and B differ only in **what they do to an in-flight effect**, and Lain already has a declared vocabulary for exactly that difference — the Phase 5 effect classes. Choosing per system what is genuinely a per-operation property is what makes the choice honest. Where the classification is absent or unrecognised, the default is A's behaviour, because the default must never be the option that risks an irreversible effect.

## 3. Effect classification — deterministic, not model-decided

The class is a **property of the tool and the arguments**, declared in the tool's contract and enforced by the execution layer. The model never supplies it. If a tool's arguments are not sufficient to determine the class, the class is `external` and the operation requires approval — the classification fails **towards** caution.

| Class | Definition (deterministic test) | Cancellation means | Retry |
|---|---|---|---|
| `read_only` | The operation cannot modify any state Lain or the user owns: reads, listing, parsing, searching, computing. Tool contract declares `writes: none`. | Immediate kill; nothing to reconcile. | Safe, budget-bounded. |
| `local_reversible` | Writes only inside the task workspace, and the prior state is either disposable or reconstructible from the workspace's own baseline (create file, edit a scratch copy). | Immediate kill; the workspace is either discarded or reset from the baseline. | Safe with an idempotency key. |
| `local_transactional` | Writes state that has its own atomic commit (a SQLite transaction, an atomic file replace). | Safe-point **bounded by the operation's own timeout**, so the commit or rollback completes; if the deadline passes, kill and mark the effect `indeterminate`. | Safe **only** if the commit is proven to have completed; otherwise never automatic. |
| `external` | Anything that leaves the machine's local control: a network write, a publish, a purchase, a message. | Never killed mid-flight silently — the request must have been made through an authorized adapter that can report its own outcome; cancellation marks the attempt `indeterminate`. | **Never automatic.** |
| `local_irreversible` | Destroys or overwrites state that cannot be reconstructed from the workspace baseline (delete user file, overwrite a source file in place). | Safe-point, and the safe-point must be **before** the destructive step, never during it. | Never automatic; approval per occurrence. |

**Two rules that make this enforceable rather than aspirational (PROPOSED):**
- An **unknown class is treated as `external`**, and `external` is not cancellable in the middle. So a mislabeled tool degrades to "ask a human", never to "the agent deleted something".
- The class is recorded in the event for the invocation, so an audit can prove which policy applied rather than inferring it.

**ESR — what this deliberately does not do.** It does not let a tool self-declare `read_only` and thereby gain immediate-kill treatment for something that writes, because the contract is checked against the tool's declared capabilities at admission: a tool holding a write capability cannot declare `read_only`. A declaration that contradicts a granted capability is refused at load, not at call time.

## 4. Required cancellation lifecycle (PROPOSED)

Numbered because the order is the contract. Each step names the event it writes.

1. **Request.** The cancellation carries `task_id`, `requested_by` (human | policy | budget | controller), `reason_code`, and a `deadline` (default 30 s, configurable). Event `task.cancel.requested`. Requesting is idempotent: a second request while one is pending does not start a second sequence.
2. **Stop admitting new work.** The scheduler sets the task's admission gate closed **before** anything else happens. No new tool call, no new model call, no new delegate. Event `task.cancel.admitted_closed`.
3. **Acknowledge.** The controller acknowledges with what is currently in flight — the running model call, the running tool, and their classes. Event `task.cancel.acknowledged` with `{in_flight: [...], classes: [...]}`. **A cancellation that is never acknowledged within the deadline escalates (step 9) rather than being reported as success.**
4. **Write the terminal intent.** Before any kill: `task.state.changed → cancelling`. This is the record that makes the outcome provable after a crash — the store write happens while everything is still alive.
5. **Act on in-flight work, per class** (§3). `read_only`/`local_reversible` → kill now. `local_transactional` → wait up to the operation's own timeout for its commit, then kill and mark indeterminate. `local_irreversible` → wait for the pre-destruction safe point, then stop; never kill between the decision and the write. `external` → let the adapter report; mark the attempt indeterminate if it cannot.
6. **Terminate the process tree.** `TerminateJobObject` on the task's job handle, which also kills any child that joined the job. This is the step that fixes audit finding S-5 (killing a parent on Windows does not kill its children). The job is created with **neither** `JOB_OBJECT_LIMIT_BREAKAWAY_OK` nor `JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK`, so children join by default and cannot break away — the trade-off being that a tool which legitimately wants its own job will fail to assign one, which must be detected as a tool defect rather than ignored.
7. **Settle the store.** Nothing to roll back in the event store: the batch either committed or never existed. If the store handle itself lost the lock (`STORE_LOCK_LOST`), the controller closes and reopens it and records the loss as its own event rather than hiding it.
8. **Verify orphans.** Enumerate the job: **zero live processes**, and record the count. A non-zero count is a **failed cancellation** (`task.cancel.failed`), never a successful one with a footnote. Known escape: an intermediate process that creates its own job — documented in [dotnet/runtime#107992](https://github.com/dotnet/runtime/issues/107992) for the Windows Python launcher, where subprocesses of the intermediate survive a tree kill. The verification exists precisely because that case is real.
9. **Escalate on timeout.** If the deadline passes with work still in flight: mark `task.cancel.escalated`, keep the job handle (do not close it), and surface to the human. **A timeout is never reported as a successful cancellation.** If the *controller* dies holding the handle, `KILL_ON_JOB_CLOSE` means the tree dies with it — the property that makes crash-time cleanup work without cooperation.
10. **Finalise.** Terminal task state and event. `cancelled` only if every verification passed; otherwise `cancel_failed` with the surviving process count, which is a distinct terminal state and not a flavour of success.

### Legal and illegal transitions

| From | To | Legal? | Note |
|---|---|---|---|
| `running` | `cancelling` | yes | step 4 |
| `cancelling` | `cancelled` | yes | only after step 8 reports zero survivors |
| `cancelling` | `cancel_failed` | yes | survivors remain, or the deadline passed |
| `cancelling` | `completed` | **no** | work that finished during cancellation is recorded as a result artifact; the task still ends `cancelled`, because the human asked it to stop |
| `cancelling` | `running` | **no** | resume is a new task or an explicit reopen, never an implicit un-cancel |
| `blocked` | `cancelling` | yes | a blocked task holds no processes; steps 6–8 are trivially satisfied and must still be *recorded* |
| `completed` / `failed` / `cancelled` | `cancelling` | **no** | terminal is terminal; a second cancel is a no-op that records `task.cancel.ignored` |
| any | `cancelling` without a request event | **no** | the record must show who asked |

**One rule above all (RECOMMENDED):** the terminal record is written **before** the kill. An implementation that kills first and records second cannot prove anything after a crash, which is the entire reason the store exists.

## 5. Acceptance criteria (PROPOSED; each needs a positive control)

| ID | Test | Threshold |
|---|---|---|
| AT-CX-01 | Cancel during a `read_only` tool call | ≤ 2 s from request to `cancelled`; 0 surviving job processes; run 20× |
| AT-CX-02 | Cancel during a `local_transactional` write | tool commits or rolls back; the store shows either a complete effect event or `indeterminate[]`; **never** a partial batch (delegates to AT-M1-14) |
| AT-CX-03 | Cancel during a `local_irreversible` step | no destructive step occurs after the request; the pre-step state is recoverable |
| AT-CX-04 | **Positive control:** a task that is *not* cancelled reaches `completed` with its checks passing | prevents "everything cancels" from looking like success |
| AT-CX-05 | Cancel with a child that spawned grandchildren | 0 survivors across the tree, verified by enumeration, 20/20 |
| AT-CX-06 | Cancel an `external` attempt | the attempt is `indeterminate`, never silently retried |
| AT-CX-07 | Controller killed mid-cancel | `KILL_ON_JOB_CLOSE` terminates the tree; on restart the task is `indeterminate`, not `cancelled` |
| AT-CX-08 | Cancellation deadline exceeded | `cancel_failed`/`escalated`, **not** `cancelled`; no automatic retry |
| AT-CX-09 | Positive control: the job handle is closed normally after a successful task | no process is killed that should not be (i.e. cleanup does not kill unrelated processes) |
| AT-CX-10 | Duplicate cancel requests | one sequence, one terminal event; the second is recorded as ignored |

## 6. Answers to the brief's hard requirements

- **"A timeout must not silently mean success."** §4 step 9 and AT-CX-08: a deadline breach produces `cancel_failed`/`escalated`.
- **"An operation with an unknown outcome must not be blindly retried."** §3's retry column plus the idempotency key; AT-CX-06.
- **"Do not let the model decide whether cancellation is permitted."** §3: the class is a tool-contract property checked against granted capabilities at load time; the model supplies neither the class nor the policy.
- **"The policy and execution layers must enforce the contract."** The Policy Engine decides admission and per-call authorization; the execution layer owns the job handle and performs the kill; the store records both.

## 7. Open questions

| # | Question | Why it matters | Who can answer |
|---|---|---|---|
| OQ-CX-1 | Default cancellation deadline: 30 s or shorter? | Bounds human-perceived responsiveness vs giving a transactional tool room to finish | User |
| OQ-CX-2 | Should a cancelled task's partial artifacts be deleted, kept, or quarantined? | Determines whether the next task can inherit a half-written workspace | User + Phase 5 checkpoint design |
| OQ-CX-3 | Does `cancel_failed` allow an immediate retry of the kill, or always escalate? | A stuck process may need one retry; repeated kills can mask a leak | Engineering judgement, then measurement |
| OQ-CX-4 | Is `local_transactional` distinct enough from `local_reversible` to earn a fifth class, or should it fold in? | Five classes are harder to keep consistent than four | Measurement once tools exist |

## 8. Reversibility

**ESR.** The lifecycle (§4) and the classification tests (§3) are cheap to change before M-2 exists — they are a document and a table. The two decisions that are expensive to reverse are (a) **which class a given tool gets**, because events recorded under one classification cannot be reinterpreted under another, and (b) **whether the terminal record precedes the kill**, because reversing that invalidates the audit property that every other guarantee rests on. Both are recommended above in the direction that is hard to retrofit: classify conservatively, record first, kill second.

**This is a recommendation. It is not an accepted user decision, and no canonical document has been changed to reflect it.**
