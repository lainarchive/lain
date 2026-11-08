# V-2 — Contained and Stoppable Execution

**Status:** authorized by the owner on 2026-11-08 — *"V-2 first, M-2 afterward"*, with V-2
scoped as **cancellation + enforced resource limits**, model-free.

**The one sentence.** V-1 proved Lain can authorize one action and account for it. V-2
proves it can **stop** — that the ceilings it writes down are ceilings it enforces, and
that a task told to stop actually stops, with the survivors counted rather than assumed.

## Why this and not the model loop

Every V-1 gap that matters is a gap in *stopping*, not in *thinking*:

| Gap (V-1 open-issues) | Consequence today |
| --- | --- |
| Issue 12 — no Job Object | `max_processes`, process memory and job time are recorded intent. Two of five ceilings are real (a timer and a buffer); three are decoration. |
| No cancellation | `cancelling` and `cancel_failed` are states in `states.mjs` that nothing can reach. AT-022 and AT-065 are unmeetable. |
| Issue 10 — no approval prompt | A2 (`APPROVAL_TIMED_OUT`) is reachable in a test and impossible in a run. `--allow` is a flag, not an answer to a question. |

A model loop built on top of a system that cannot stop a runaway tool run is a worse
foundation than the reverse order, and the owner chose the reverse order.

## Non-goals (explicit)

- **No model call of any kind.** Not in code, not in a test, not in this document's
  acceptance run. M-2 owns that.
- No network restriction. No read restriction. No UI/COM isolation. These stay declared
  limitations; a reader who assumes otherwise has been misled by omission, not by claim.
- No AppContainer/LPAC work. Tier 1 only.
- No delegation, plugins, knowledge graph, or interface beyond the CLI.
- No new runtime dependency. `winget`, `scoop`, pip and npm installs are all out; the
  mechanism below uses what is already on the machine.

## What was measured before designing (probe: `tools/experiments/job-object-probe.py`)

Run on 2026-11-08, Python 3.15.0, Windows 11 26200. The probe creates a job, assigns
itself, and then measures what actually happens — the point being that a limit which
*fails to set* and a limit which *is set and enforced* look identical from the API.

The table below is the short form. The long form follows it, because each answer
carries a consequence that a table cell cannot hold.

| Question | Short answer |
| --- | --- |
| Drive a job object from `ctypes`, no compiler, no addon, no pip? | **Yes.** |
| Does `ACTIVE_PROCESS = 1` bound "one process"? | **No — it is fatal.** |
| Are the memory limits enforced, or only registered? | **Enforced.** |
| Does the job time limit end a process that is still working? | **Yes.** |
| Does assignment need breakaway when Lain is already inside a job? | **Yes, and not optionally.** |

**`ACTIVE_PROCESS = 1` is fatal, not a process ceiling.** With it set, *the process's own
first child cannot be created*: `CreateProcess` fails `WinError 1816`
(`ERROR_NOT_ENOUGH_QUOTA`). The spawning process already counts toward the limit, so a
limit of 1 leaves no room for anything it starts. Even 1024 MiB of headroom does not
change it. This is the single most important measurement here, because the natural
reading of "active process limit: 1" is exactly the thing that does not work.

**The memory limits are enforced, not merely registered.** With 1024 MiB set,
`ctypes.create_string_buffer` plus a touch of every page for 1536 MiB **failed with
`MemoryError`**; 128 MiB against the same limit survived. The death is the evidence; the
earlier quota error only proved registration.

**The job time limit ends a process that is still working.** `job_seconds: 1` with an 8 s
busy loop ended the child at **2.75 s** with exit `3221225540` (`0xC0000044`,
`STATUS_QUOTA_EXCEEDED`). The overshoot past 1 s is the accounting interval, and it is a
real cost to state rather than round away.

**`KILL_ON_JOB_CLOSE` was set in every enforced case.** Closing the handle is therefore
available as the kill switch, which is what makes the supervisor design below work.

**Breakaway is required, and only in one direction.** This DSH host process is itself
inside a job, so `AssignProcessToJobObject` on a fresh job returned
`ERROR_INVALID_HANDLE` (6) — a misleading code for a job-nesting refusal. Setting
`JOB_OBJECT_LIMIT_BREAKAWAY_OK` on *Lain's* job makes the assignment succeed. Conversely,
asking a child to break away from the *outer* job failed with `ERROR_ACCESS_DENIED` (5)
until `CREATE_BREAKAWAY_FROM_JOB` was dropped from the spawn. Both directions are recorded
because both were wrong first.

**Consequence for the design.** The process ceiling cannot be delegated to the job API.
Lain's `max_processes` must be enforced by something that can enumerate — and the honest
options are (a) `CreateToolhelp32Snapshot` from the same helper process, or (b) admit that
only the *number of tool runs* is bounded, not the number of grandchildren. Tier 1 has no
answer for (a) without more native surface, so V-2 does (b) **and says so in the ceiling
table**, because a silently unenforced limit is worse than an absent one.

## Architecture

One new seam and three consumers. The seam is the only place a process is created, which
is already the invariant `tools/check/process-boundary.mjs` enforces.

```
src/exec/job.mjs          spawn a tool process under a job object   (new)
src/exec/limits.mjs       the ceiling table, one entry per ceiling   (new)
src/exec/workspace.mjs    run() delegates to the runner seam         (changed)
src/exec/one-shot.mjs     unchanged: the no-workspace primitive
tools/win32/job_host.py   the helper that talks to Win32             (new)
```

The helper is a **supervisor**, not a launcher. It creates the job, keeps the handle,
enables `KILL_ON_JOB_CLOSE`, then spawns the tool **suspended**, assigns the *tool* to the
job, and resumes it.

```
Lain (node)  --spawn-->  job_host.py  --holds handle-->  [job object]
                              |                              |
                              +--spawn suspended--> tool ----+
                                     then AssignProcessToJobObject(tool), then resume
```

**This shape was corrected by measurement, and the correction is the interesting part.**
The first design had the supervisor assign *itself*, so that job lifetime would trivially
equal supervisor lifetime. That is fatally wrong: `JOB_OBJECT_LIMIT_JOB_TIME` accounts the
**whole job**, so the supervisor dies at the same instant as the tool it was supposed to
report on. The measured case (`time_burn`, assign=self) ended with `exit=None wall=None`,
the supervisor killed, and **the result file never written** — a supervisor that dies with
its subject reports nothing, which is precisely the failure this design exists to prevent.
With `assign=child`, the same run gave `child exit=0xc0000044`, `wall=2.07s`, the
supervisor **surviving**, and notifications
`[NEW_PROCESS, END_OF_JOB_TIME, ACTIVE_PROCESS_ZERO]`.

Every property the self-assignment was meant to buy still holds, from a different cause:

1. **Job lifetime equals supervisor lifetime** — because the supervisor *holds the handle*
   with `KILL_ON_JOB_CLOSE` set, not because it is a member. Measured in both shapes:
   killing the supervisor reaps the child (`child_alive_after=false`).
2. **From Node's side, it is still one process.** `kill(pid)` remains the only mechanism
   needed, so the Win32 surface stays entirely inside Python.
3. **The escape window is now closed rather than narrowed.** The tool is created
   `CREATE_SUSPENDED`, so it cannot run or spawn anything until it is already inside the
   job. Resuming needs `OpenProcess(PROCESS_SET_QUOTA|PROCESS_TERMINATE|PROCESS_SUSPEND_RESUME)`
   followed by `NtResumeProcess`; **without the `0x0800` right it returns `0xC0000022`
   (`STATUS_ACCESS_DENIED`) and the child hangs forever** — a hang with no error, which is
   the worst available failure mode, so it is written down here rather than rediscovered.
4. **The tool tree is outside Lain's job.** A job inside a job is what forced
   `BREAKAWAY_OK`; the supervisor's own job is fresh, so the tool's grandchildren are in a
   job Lain controls rather than one it merely shares.

### What the time and memory ceilings actually do — measured

Three corrections to the intuitive reading, all measured with `tools/experiments/`:

- **`JOB_OBJECT_LIMIT_PROCESS_TIME` never fires.** An 8.04 s burn under a `process_ms`
  ceiling of 1000 ran to completion with exit 0. Per-process time is therefore unusable,
  and the time ceiling must be `JOB_OBJECT_LIMIT_JOB_TIME`. This is a trap: the field
  exists, accepts the value, and does nothing.
- **Job time is user-mode CPU time, not wall clock.** A 4.05 s `sleep` under a 1000 ms job
  ceiling completed normally, exit 0. **The time ceiling does not bound an idle or sleeping
  tool.** That limitation is stated in `CEILINGS[].mechanism`, not hidden, because a number
  that looks enforced and is not is worse than a number that is absent.
- **The memory ceiling fails the allocation rather than terminating the process.** The
  tool dies with `MemoryError` and exit 1, but the job posts `PROCESS_MEMORY_LIMIT` —
  which is why `killed_by_job` must be derived from that **notification** rather than
  inferred from an exit code. A tool that exits `0xC0000044` for its own reasons is not the
  same event as the job killing it, and the log must not conflate the two. Measured
  notification order: `[NEW_PROCESS, PROCESS_MEMORY_LIMIT, EXIT_PROCESS, ACTIVE_PROCESS_ZERO]`.
- **Overshoot is real and is reported, not rounded.** A 1000 ms job ceiling ended a busy
  8 s loop at **2.07–2.17 s** (an earlier probe measured 2.75 s). That spread is the
  accounting interval, and it belongs in the ceiling's description.

**The helper is a soft target, stated plainly.** Anything holding the supervisor's PID can
kill it, and anything that can write the helper file can change what it enforces. Neither
is defended against in V-2. What *is* true is that tampering is not silent: the helper
hash is recorded at launch and the exit code and timing are recorded at settle, so a
tampered or replaced helper is visible in the log even though it is not prevented. This is
the same class of statement `SECURITY_MODEL.md` §10 makes, and the sentence still ends
"**Lain is not a sandbox.**"

## Interface contracts — frozen for this milestone

These are written before the code because three workstreams meet here. Changing one after
the streams start means re-doing work in another, so a change is a Lead decision.

### 1. The runner seam (`src/exec/job.mjs`)

```js
/**
 * @param {{
 *   command: string,
 *   args?: string[],
 *   cwd: string,
 *   env: Record<string, string>,
 *   limits: {process_memory_bytes?: number, job_ms?: number, kill_on_close?: boolean},
 *   supervisorMs?: number,          // backstop if the helper itself hangs
 * }} spec
 * @returns {{
 *   pid: number|null,
 *   job_name: string,
 *   limits_applied: string[],       // which ceilings actually reached Win32
 *   limits_refused: {limit: string, code: string, detail: string}[],
 *   stdout: string, stderr: string, // buffered, already truncated by the caller's ceiling
 *   output_truncated: boolean,
 *   exit_code: number|null,
 *   status: 'ok'|'exit_nonzero'|'killed_by_job'|'killed_by_supervisor'|'spawn_failed'|'timeout',
 *   killed_by: string|null,         // 'job_time'|'process_memory'|'job_memory'|'cancel'|null
 *   duration_ms: number,
 *   supervisor_exit: number|null,
 *   supervisor_ms: number,
 *   helper_sha256: string,
 * }} JobRunResult
 */
async function runInJob(spec)
```

`status` is derived from evidence, never assumed: `killed_by_job` requires exit
`0xC0000044` **or** a resource-limit notification read back from the job, and a non-zero
supervisor exit with normal tool output is `spawn_failed`, not success.

### 2. The ceiling table (`src/exec/limits.mjs`)

One row per ceiling, each with how it is enforced and its true state. This table is the
artifact that replaces prose claims in `RESOURCE_BUDGET.md`.

```js
/** @type {{name: string, enforced_by: 'job_object'|'timer'|'buffer'|'counter'|'none',
 *          mechanism: string, measured: string|null}[]} */
export const CEILINGS = [ /* max_processes, process_memory, job_time, output_bytes, tool_calls */ ]
```

`enforced_by: 'none'` is a legal value and the table must be able to say it. A ceiling whose
`measured` is `null` renders as "configured, not measured" in every report that prints it.

### 3. Cancellation (`src/agent/cancel.mjs`)

Model C — hybrid by effect class — as the M-2 preflight recommended, with the ten-step
lifecycle. Frozen bits:

- `requestCancellation(taskId, {reason, requested_by})` is **idempotent**: a second call
  returns the existing request rather than opening a second one.
- The terminal intent row is written **before** any kill. There is no ordering in which a
  process dies before the log says it was supposed to.
- `read_only` → stop at the next safe point (no kill needed).
  `local_reversible` → kill the process tree, then record what was written.
  `local_transactional` → kill, then mark the partial write unusable rather than deleting it.
  `external`, `local_irreversible`, and **anything unknown** → never kill silently; escalate
  to a human.
- Survivors are **enumerated and recorded**. `cancelled` requires zero survivors; otherwise
  the task settles as `cancel_failed` with the survivor count in the evidence.

### 4. Approval (`src/cli/commands/approve.mjs`, `src/policy/approvals.mjs`)

- A pending approval is presented as the bound question: action, tool, target, effect class,
  and the request digest.
- The answer is accepted only if the digest matches the pending request. A `--allow` flag
  remains for non-interactive use but must be **recorded as a flag-shaped approval**, not as
  a human answer, so the log distinguishes the two.
- Timeout → `deny_indeterminate`, recorded as `decided_by: 'timeout'`, **never retried**
  (OD-7). "Wait forever" is not a supported answer.

## Acceptance criteria

Each is a test that fails before the change and passes after, and each has a positive
control — a test that would fail if the mechanism stopped working.

| ID | Claim | Positive control |
| --- | --- | --- |
| AT-V2-JOB-01 | A tool run under `process_memory` is killed when it commits past the ceiling | the same run 128 MiB under the ceiling completes normally |
| AT-V2-JOB-02 | A tool that overruns `job_ms` is stopped, and the overshoot is reported | a run well inside the ceiling completes normally |
| AT-V2-JOB-03 | Killing the supervisor reaps the whole tree — **no survivor** | a run left alone exits on its own |
| AT-V2-JOB-04 | A ceiling that could not be applied is reported, not silently dropped | a valid ceiling reports no refusal |
| AT-V2-CAN-01 | A second `requestCancellation` returns the first request | the first call creates exactly one |
| AT-V2-CAN-02 | The terminal intent row precedes the kill | the row exists after a cancellation that kills |
| AT-V2-CAN-03 | Unknown effect class → escalate, never kill | a `local_reversible` task is killed |
| AT-V2-CAN-04 | `cancelled` is refused with survivors; `cancel_failed` carries the count | zero survivors reaches `cancelled` |
| AT-V2-APR-01 | Approval timeout → `deny_indeterminate`, `decided_by: 'timeout'` | an in-window grant allows |
| AT-V2-APR-02 | An answer with the wrong digest is refused | the right digest is accepted |
| AT-V2-APR-03 | A `--allow` grant is recorded as flag-shaped, not as a human answer | a prompted grant is recorded as prompted |

**The milestone's own test:** `lain task run --cancel-after <ms>` on a task that would
otherwise run for minutes reaches a terminal state within a bounded time, leaves **zero
surviving processes** (checked against the OS, not against Lain's own bookkeeping), and
`lain store verify` passes afterwards.

## Risk and reversal

Risk and mitigation, as pairs rather than a table, because the mitigations are longer
than a table cell should hold.

- **The conversion of `workspace.run` touches every call site and existing test.**
  `one-shot.mjs` stays untouched; a synchronous fallback is allowed only if it is
  *reported* as unenforced, never silently.
- **The helper becomes a native dependency in disguise.** It selects the interpreter by
  explicit absolute path with no PATH search; absence is a reported, fail-closed state,
  not a fallback to unenforced execution.
- **A partial write left by a killed process is mistaken for a complete artifact.**
  `local_transactional` marks it unusable, and acceptance criteria evaluate only the
  artifacts a run claims — a killed run claims nothing.
- **Cancellation becomes a way to make failures disappear.** The terminal row is written
  before the kill, and `cancelled` still requires its checks to have passed.

**Reversal.** Every change is a local commit; `git revert <hash>` restores V-1 behaviour.
V-1's acceptance test (`AT-V1-E2E-*`) must keep passing throughout — if V-2 breaks the
ability to complete a normal task, V-2 is wrong even if its own tests pass.
