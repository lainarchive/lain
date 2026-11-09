# What a tool run costs

Five runs per row, same machine, same trivial command (`node -e`), taken while
building this table. The numbers that matter are the two `runInJob` rows.

| | before | after |
| --- | --- | --- |
| bare `python -c pass` | 51.6 ms | 49.9 ms |
| bare `node -e` | 79.4 ms | 83.6 ms |
| `runInJob`, plain | **863.1 ms** | **216.7 ms** |
| `runInJob`, container | **882.6 ms** | **242.5 ms** |
| `icacls` grant, one directory | 24.4 ms | 28.3 ms |
| `createWorkspace` + container grant | 74.2 ms | 54.3 ms |

## Where the 863 ms went

Attribution, before the fix: supervisor overhead 811.5 ms
(`runInJob` 863.1 − bare python 51.6), of which the tool was 79.4 ms — **9% of a
run was the work and 91% was the wrapper**. Python interpreter startup is only
51.6 ms of it, so roughly 760 ms was unaccounted for by anything the run did.

It was one line. `drain_port(port, 0.6)` collected job notifications in a loop
that ran until its deadline and never returned early, so every run — success,
quota kill, or timeout — slept 600 ms after the tool had already exited.

`ACTIVE_PROCESS_ZERO` is the job saying it holds no process at all. No
notification about that run can follow it, so the loop now ends there, and the
0.6 s budget stays as the bound for a job that never empties. The early exit is
safe because the notifications queued *before* it are still drained first:
`GetQueuedCompletionStatus` returns them in order, and the tests that assert
specific ones — `PROCESS_MEMORY_LIMIT`, `END_OF_JOB_TIME`, `JOB_MEMORY_LIMIT` —
still pass unchanged.

After the fix the supervisor's overhead is 166.8 ms, the tool is 39% of a run,
and `npm test` fell from 35,640 ms to 23,058 ms for the same suite.

## The container costs 25.7 ms

`runInJob` container minus `runInJob` plain, after the fix. Before the fix the
same comparison read 19.4 ms, which was wrong in an instructive way: a 600 ms
constant was sitting on both sides of the subtraction and hiding the real one.
A fixed cost shared by both arms makes their difference look smaller, not larger,
and the difference was the number being reported.

That 25.7 ms buys the whole read boundary: the profile SID resolved once, the
`PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` attribute list built, and the child
created inside the AppContainer. `icacls` on the workspace is separate — 24–28 ms
per task directory, paid once at workspace creation, not per run.

## What this does not measure

- A tool that does real work. These are all `console.log(1)`; the wrapper is now
  small enough that a real command's own runtime dominates, which was not true
  before.
- The `job_ms` ceiling. That is charged in user-mode CPU time, so the wall-clock
  delay before a burn is stopped is a function of how much CPU the tool is
  granted, measured elsewhere at 2.07 s to 8.13 s for a 1000 ms ceiling.
- Memory. The ceilings fail an allocation rather than slowing anything down.
- Any machine other than this one, and any interpreter other than Node 24.21.0
  and Python 3.15.0.
