// The five resource ceilings, and which of them can actually stop a tool.
//
// A ceiling that is written down but not enforced is worse than an absent one,
// because a reader budgets against it. So every row names the mechanism that
// stops the tool, or says `none` and carries the measurement that says why.

/**
 * @typedef {'job_object'|'timer'|'buffer'|'counter'|'none'} CeilingEnforcement
 * @typedef {object} Ceiling
 * @property {string} name
 * @property {CeilingEnforcement} enforced_by
 * @property {string} mechanism
 * @property {string|null} measured
 */

/** Contract 2 of docs/implementation/v2-contained-execution.md. @type {Ceiling[]} */
export const CEILINGS = [
  {
    name: 'max_processes',
    enforced_by: 'none',
    mechanism:
      'Nothing in the kernel enforces this one. JOB_OBJECT_LIMIT_ACTIVE_PROCESS counts the process doing the '
      + 'spawning, so a limit of 1 starves the spawner rather than the spawned: the first CreateProcess inside the '
      + 'job fails WinError 1816 ERROR_NOT_ENOUGH_QUOTA, and the tool that asked to spawn something is the one that '
      + 'dies. Assigned to a tool it would bound that tool\'s children, not the tool, and break every tool that '
      + 'legitimately spawns - which is exactly what SCRIPT_CAPABILITIES grants. I left it unenforced and bounded the '
      + 'NUMBER OF TOOL RUNS instead, which is a different promise and is said here rather than implied by a row that '
      + 'looks enforced.',
    measured:
      'ACTIVE_PROCESS=1 (tools/experiments/active-process-probe.py): assign-after-spawn gave assign_ok=true, '
      + 'child_exit=0, stdout "ran"; spawn-inside-job gave self_assign_ok=true, spawn_ok=false, WinError 1816 '
      + 'ERROR_NOT_ENOUGH_QUOTA "Not enough quota is available to process this command".',
  },
  {
    name: 'process_memory',
    enforced_by: 'job_object',
    mechanism:
      'JOB_OBJECT_LIMIT_PROCESS_MEMORY (0x100) on the tool\'s job. It bounds commit, so the allocation FAILS rather '
      + 'than the kernel terminating the process: the interpreter dies on its own, MemoryError and exit 1. The job '
      + 'then posts PROCESS_MEMORY_LIMIT (message 9), and that notification and not the exit code is the evidence a '
      + 'kill was ours - a tool that exits non-zero for its own reasons must not be logged as a job kill.',
    measured:
      '64 x 8 MiB buffers against a 256 MiB ceiling: PROCESS_MEMORY_LIMIT posted, MemoryError on stderr, exit 1, no '
      + 'completion output; 2 x 8 MiB under the same ceiling: exit 0 (AT-V2-JOB-01).',
  },
  {
    name: 'job_time',
    enforced_by: 'job_object',
    mechanism:
      'JOB_OBJECT_LIMIT_JOB_TIME (0x4) on the tool\'s job. The supervisor stays out of that job on purpose: a '
      + 'job-wide time limit kills it at the same instant as the tool it exists to report on, and a supervisor that '
      + 'dies with its subject reports nothing. Two limits worth stating plainly. This ceiling is charged in '
      + 'USER-MODE CPU TIME, not wall clock, so it does not bound an idle or sleeping tool. And the delay before it '
      + 'lands is a function of how much CPU the tool is given rather than a fixed accounting interval. supervisor_ms '
      + 'is the backstop that does bound a sleeping tool, and it reports status timeout, not killed_by_job.',
    measured:
      'a 1000 ms ceiling ended an 8 s busy loop with exit 0xC0000044 and an END_OF_JOB_TIME notification, the '
      + 'wall-clock overshoot ranging 2.07-8.13 s with machine load; a 4.05 s sleep under the same 1000 ms ceiling '
      + 'completed normally with exit 0; JOB_OBJECT_LIMIT_PROCESS_TIME never fired at all - an 8.04 s burn ran to '
      + 'completion under a 1000 ms per-process ceiling (AT-V2-JOB-02).',
  },
  {
    name: 'output_bytes',
    enforced_by: 'buffer',
    mechanism:
      'Reader threads in the supervisor keep at most output_bytes per stream and set output_truncated at the cap. A '
      + 'tool that keeps writing past it is terminated with kill_reason "output_ceiling" rather than allowed to fill '
      + 'memory. workspace.run slices both streams to maxOutputBytes again on the way out.',
    measured:
      'a tool writing past a 65536-byte cap was terminated with kill_reason "output_ceiling" and output_truncated true.',
  },
  {
    name: 'tool_calls',
    enforced_by: 'none',
    mechanism:
      'A counter is intended and the check exists - src/tools/invoke.mjs:80 denies with TOOL_CALL_BUDGET when '
      + 'budget.remaining_tool_calls <= 0 - but the counter is never advanced. src/agent/task-runner.mjs:374-378 '
      + 'builds a fresh budget object per invocation and nothing in src/ decrements it, so a positive ceiling is '
      + 'compared and can never be reached by spending calls, and only a contract ceiling of 0 denies anything. '
      + 'Recorded as unenforced because the fix belongs to the tool runner, not to this seam.',
    measured:
      'a search of src/ for "remaining_" finds two typedef comments, the read at src/tools/invoke.mjs:80 and the '
      + 'write at src/agent/task-runner.mjs:375; no decrement exists. TOOL_CALL_BUDGET occurs exactly once in the '
      + 'repository, that same check, so no other code path enforces or tests this ceiling.',
  },
];

// "we never checked" must not read like "enforced".
/** @type {string} */
export const NOT_MEASURED = 'configured, not measured';

/** @returns {string[]} */
export function unenforcedCeilings() {
  return CEILINGS.filter((ceiling) => ceiling.enforced_by === 'none').map((ceiling) => ceiling.name);
}

/** @param {Ceiling} ceiling @returns {string} */
export function renderCeiling(ceiling) {
  const measured = ceiling.measured === null ? NOT_MEASURED : ceiling.measured;
  return `${ceiling.name}: enforced_by=${ceiling.enforced_by} - ${measured}`;
}

/** @returns {string[]} */
export function describeCeilings() {
  return CEILINGS.map(renderCeiling);
}
