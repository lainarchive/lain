# Cancellation, phase by phase, at the execution layer

What the execution layer (`src/exec/`) does and reports when a run is cancelled,
and what it refuses to report. The task-level phases — state transitions,
`requestCancellation`, `takeOverState` — live in `src/agent/task-runner.mjs` and
`src/agent/cancel.mjs`; this records the layer underneath them, which is the one
that has to be honest for the rest to mean anything.

## The rule the layer exists to keep

**A kill is reported only when the kill was ours, and a run that finished is
never relabelled a cancellation.** Everything below is a measurement of that
sentence, not a restatement of it.

The mechanism: `spawnSupervisor` keeps a `killedByCaller` flag that is set **only
when `child.kill()` returns true**:

```js
const kill = () => { if (child.kill()) killedByCaller = true; return killedByCaller; };
```

If the supervisor has already exited, `child.kill()` returns false, the flag stays
false, and the result is whatever the run actually did. A cancel that arrives one
millisecond too late is not counted as a cancel.

## The phases

| Phase | How it was driven | What came back |
| --- | --- | --- |
| before the tool starts | `createJobControl(id)` called in the same tick as `runInJob` | `killed_by_supervisor`, `killed_by: 'cancel'` — the supervisor is alive, so the kill is real |
| while the tool runs | 6 s blocking script, `--cancel-after 1500` | supervisor died at 1747 ms, exactly at the cancel; `STARTED=True FINISHED=False` |
| with descendants | `taskkill /F /PID <supervisor>` with no `/T` | grandchild `powershell.exe Start-Sleep 60` was alive before the kill and gone after it |
| with descendants, containerised | same, tool launched in `lain.tool.runner` | `grandchild_pid: 3444 alive_before_kill: True` → `grandchild_alive_after_kill: False` |
| racing normal exit | `AT-V2-JOB-11`, ten rounds with the cancel arriving later each time | every round landed on `ok` or `killed_by_supervisor`; both were seen |
| after completion | `createJobControl(id)` once the run has settled | `null` |
| kill cannot be confirmed | `terminate()` polls `alive(pid)` at 50 ms up to 100 times | returns only after the pid is gone, so its caller is never told "done" on a guess |

The descendant phases are the ones that justify the whole shape: killing the
supervisor reaps the tree because the job was created with `KILL_ON_JOB_CLOSE`
and the supervisor is the only holder of that handle. Node kills one pid and the
kernel does the rest.

## What the result may say

- `killed_by_supervisor` always carries `killed_by: 'cancel'`. There is no other
  way to reach that status.
- A run that reports `ok` has `exit_code: 0` and `killed_by: null`. A completed
  run cannot also carry a kill.
- A wall-clock stop is `timeout` / `killed_by: null` / `kill_reason:
  'supervisor_ms'`, and the helper's own backstop is `kill_reason:
  'supervisor_timeout'`. Neither borrows the word `cancel` — that word is
  reserved for "this process stopped it", and a timed-out tool was stopped by a
  clock. Getting this wrong would let a cancellation count a timeout as a kill.
- A kernel notification outranks the helper's own account of itself. If the job
  posted `PROCESS_MEMORY_LIMIT`, the verdict is `killed_by_job` /
  `process_memory` even if the helper recorded something else.
- `createJobControl(id)` returns `null` when there is no live run. **Null means
  unknown, not zero.** An `indeterminate` task with a missing handle has an
  unknown survivor count, and reporting that as zero survivors would be a false
  confirmation of the exact thing cancellation is supposed to prove. The decision
  lives in `src/agent/cancel.mjs`.

## The trap this layer was built around

Two failure modes look identical from the outside and are not:

1. A tool that was killed, whose output is empty because it never got to write.
2. A tool that never started, whose output is empty for the same reason.

`job_host.py` resolves it by writing the child's stdout and stderr to **files it
creates and the child inherits**, never to pipes, and by checking an
`expect_marker` when the caller asks for one. A pipe in an AppContainer is a
handle the child cannot write to, so a piped child produces empty output that
cannot be told apart from a child that never ran — the lead hit this twice and
lost an hour to it, and the AppContainer probe's first results were meaningless
because of it. An empty output with a marker missing is now a refusal, not a pass.

The same shape appears three times in this milestone: a truncated script that
exits 0, an empty pipe that reads as a silent child, and a grandchild that was
already dead when the reap test looked. Each is **an absence that cannot be told
apart from a success**, and each is fixed by asserting the positive control
inside the same run rather than beside it.

## Not determined

- The task-level phase count. The brief names seven; this measures six shapes at
  the execution layer and does not claim to be the same set.
- Cancellation during output collection for a tool that is producing output
  faster than the cap: the truncation path kills the job and sets
  `kill_reason: 'output_ceiling'`, which is reported as `killed_by_supervisor`
  but is not a cancel, and no test drives that path concurrently with a cancel.
- Whether `terminate()`'s 5 s poll is long enough on a machine under load. It has
  never timed out here.
