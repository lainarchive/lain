/**
 * AT-V2-JOB-01..04: the job-object ceilings, and the controls that prove the
 * test can tell a stopped tool from one that merely stopped.
 *
 * Every case runs a real process through the real supervisor. Nothing here
 * asserts that a limit was *set*; each case asserts what the kernel did.
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  createJobControl, DEFAULT_HELPER, deriveOutcome, EXIT_QUOTA_EXCEEDED, resolvePython, runInJob,
} from '../../src/exec/job.mjs';
import { CEILINGS, describeCeilings, renderCeiling, unenforcedCeilings } from '../../src/exec/limits.mjs';
import { createWorkspace } from '../../src/exec/workspace.mjs';

const PYTHON = resolvePython();
const skip = PYTHON.ok ? false : `no interpreter at ${PYTHON.candidate}`;
const NODE = process.execPath;
const ROOT = mkdtempSync(join(tmpdir(), 'lain-job-test-'));

after(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

/** A busy loop that will not finish inside the ceilings used here. */
const BURN_60S = 'const end = Date.now() + 60000; let n = 0; while (Date.now() < end) n += 1;';

/** Commits well past a 256 MiB ceiling. */
const ALLOC_OVER = `
const chunks = [];
for (let i = 0; i < 64; i += 1) chunks.push(Buffer.alloc(8 * 1024 * 1024, i % 251));
console.log('allocated ' + chunks.length);
`;

/** The same shape, comfortably inside it. */
const ALLOC_UNDER = `
const chunks = [];
for (let i = 0; i < 2; i += 1) chunks.push(Buffer.alloc(8 * 1024 * 1024, i % 251));
console.log('allocated ' + chunks.length);
`;

const MEMORY_CEILING = 256 * 1024 * 1024;

/**
 * @param {number} pid
 */
function pidAlive(pid) {
  const out = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'],
    { encoding: 'utf8', windowsHide: true });
  return (out.stdout ?? '').includes(String(pid));
}

/**
 * @param {() => boolean} predicate
 * @param {number} timeoutMs
 */
async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((done) => setTimeout(done, 100));
  }
  return predicate();
}

/**
 * @param {() => any} produce
 * @param {number} timeoutMs
 */
async function waitForValue(produce, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = produce();
    if (value) return value;
    await new Promise((done) => setTimeout(done, 100));
  }
  return produce();
}

test('AT-V2-JOB-01 a tool that commits past process_memory is stopped by the job', { skip }, async () => {
  const result = await runInJob({
    command: NODE,
    args: ['-e', ALLOC_OVER],
    cwd: ROOT,
    limits: { process_memory_bytes: MEMORY_CEILING },
    supervisorMs: 30_000,
  });

  assert.ok(result.limits_applied.includes('process_memory'),
    `process_memory should be applied, got ${JSON.stringify(result.limits_applied)}`);
  const names = result.notifications.map((note) => note.name);
  assert.ok(names.includes('PROCESS_MEMORY_LIMIT'),
    `the job should post PROCESS_MEMORY_LIMIT, got ${JSON.stringify(names)}`);
  // The verdict must come from that notification: the tool dies of a failed
  // allocation (exit 1), not of a quota exit code, so the exit code alone
  // would have called this an ordinary failure.
  assert.equal(result.status, 'killed_by_job');
  assert.equal(result.killed_by, 'process_memory');
  assert.equal(result.stdout.includes('allocated'), false, 'the tool should not have finished');
});

test('AT-V2-JOB-01 control: the same run under the same ceiling completes normally', { skip }, async () => {
  const result = await runInJob({
    command: NODE,
    args: ['-e', ALLOC_UNDER],
    cwd: ROOT,
    limits: { process_memory_bytes: MEMORY_CEILING },
    supervisorMs: 30_000,
  });

  assert.equal(result.status, 'ok', `expected a clean run, got ${result.status}/${result.kill_reason}`);
  assert.equal(result.exit_code, 0);
  assert.equal(result.stdout.includes('allocated'), true);
  assert.equal(result.notifications.some((n) => n.name === 'PROCESS_MEMORY_LIMIT'), false);
});

test('AT-V2-JOB-02 a tool that overruns job_ms is stopped and the overshoot is reported', { skip }, async () => {
  const jobMs = 500;
  const result = await runInJob({
    command: NODE,
    args: ['-e', BURN_60S],
    cwd: ROOT,
    limits: { job_ms: jobMs },
    supervisorMs: 25_000,
  });

  assert.equal(result.status, 'killed_by_job', `expected the job to stop it, got ${result.status}`);
  assert.equal(result.killed_by, 'job_time');
  assert.equal(result.exit_code, EXIT_QUOTA_EXCEEDED,
    `expected 0xC0000044, got ${result.exit_code === null ? 'null' : `0x${result.exit_code.toString(16)}`}`);
  assert.ok(result.notifications.some((n) => n.name === 'END_OF_JOB_TIME'),
    `expected END_OF_JOB_TIME, got ${JSON.stringify(result.notifications.map((n) => n.name))}`);
  // The ceiling is charged in user-mode CPU time, so the wall-clock delay is
  // never the ceiling itself. It is reported rather than rounded away.
  assert.ok(result.duration_ms > jobMs,
    `the overshoot should be visible: ${result.duration_ms}ms for a ${jobMs}ms ceiling`);
});

test('AT-V2-JOB-02 control: a run well inside job_ms completes normally', { skip }, async () => {
  const result = await runInJob({
    command: NODE,
    args: ['-e', 'console.log("quick")'],
    cwd: ROOT,
    limits: { job_ms: 20_000 },
    supervisorMs: 30_000,
  });

  assert.equal(result.status, 'ok', `expected a clean run, got ${result.status}/${result.kill_reason}`);
  assert.equal(result.exit_code, 0);
  assert.equal(result.notifications.some((n) => n.name === 'END_OF_JOB_TIME'), false);
});

test('AT-V2-JOB-03 killing the supervisor reaps the whole tree', { skip }, async () => {
  const pidFile = join(ROOT, 'grandchild.pid');
  const specPath = join(ROOT, 'tree.spec.json');
  const resultPath = join(ROOT, 'tree.result.json');
  writeFileSync(pidFile, '');

  // The tool spawns a grandchild that records its own pid, then both linger.
  const tool = `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync(process.env.LAIN_TEST_PIDFILE, String(kid.pid));
setInterval(() => {}, 1000);
`;
  writeFileSync(specPath, JSON.stringify({
    command: NODE,
    args: ['-e', tool],
    cwd: ROOT,
    env: { ...process.env, LAIN_TEST_PIDFILE: pidFile },
    output_bytes: 65_536,
    supervisor_ms: 60_000,
  }));

  const supervisor = spawn(PYTHON.candidate,
    [DEFAULT_HELPER, '--spec', specPath, '--result', resultPath],
    { windowsHide: true, stdio: 'ignore' });

  try {
    const recorded = await waitFor(() => readFileSync(pidFile, 'utf8').trim() !== '', 20_000);
    assert.ok(recorded, 'the grandchild should have recorded its pid');
    const grandchild = Number(readFileSync(pidFile, 'utf8').trim());
    assert.ok(pidAlive(grandchild), 'the grandchild should be running before the kill');

    // Kill ONLY the supervisor - no /T. Nothing else may reap the tree: if the
    // grandchild dies, it died because the job handle closed.
    const killed = spawnSync('taskkill', ['/F', '/PID', String(supervisor.pid)],
      { encoding: 'utf8', windowsHide: true });
    assert.equal(killed.status, 0, `taskkill failed: ${killed.stdout}${killed.stderr}`);

    const reaped = await waitFor(() => pidAlive(grandchild) === false, 20_000);
    assert.ok(reaped, `grandchild ${grandchild} survived the supervisor`);
  } finally {
    supervisor.kill();
  }
});

test('AT-V2-JOB-03 control: a run left alone exits on its own', { skip }, async () => {
  const result = await runInJob({
    command: NODE,
    args: ['-e', 'console.log("done")'],
    cwd: ROOT,
    limits: { job_ms: 20_000 },
    supervisorMs: 30_000,
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.exit_code, 0);
  assert.equal(result.stdout.trim(), 'done');
});

test('AT-V2-JOB-04 a ceiling that could not be applied is reported, not dropped', { skip }, async () => {
  const missingHelper = await runInJob({
    command: NODE,
    args: ['-e', 'console.log("should not run")'],
    cwd: ROOT,
    helperPath: join(ROOT, 'no-such-job_host.py'),
  });

  assert.equal(missingHelper.status, 'spawn_failed');
  assert.equal(missingHelper.limits_applied.length, 0);
  assert.equal(missingHelper.limits_refused[0]?.code, 'HELPER_MISSING');
  assert.equal(missingHelper.stdout, '', 'nothing may run unenforced');

  const missingPython = await runInJob({
    command: NODE,
    args: ['-e', 'console.log("should not run")'],
    cwd: ROOT,
    python: join(ROOT, 'no-such-python.exe'),
  });

  assert.equal(missingPython.status, 'spawn_failed');
  assert.equal(missingPython.limits_refused[0]?.code, 'INTERPRETER_MISSING');
  assert.equal(missingPython.stdout, '', 'nothing may run unenforced');
});

test('AT-V2-JOB-04 control: a valid ceiling reports no refusal', { skip }, async () => {
  const result = await runInJob({
    command: NODE,
    args: ['-e', 'console.log("ok")'],
    cwd: ROOT,
    limits: { job_ms: 20_000 },
    supervisorMs: 30_000,
  });

  assert.deepEqual(result.limits_refused, []);
  assert.ok(result.limits_applied.includes('job_time'));
  assert.match(result.helper_sha256 ?? '', /^[0-9a-f]{64}$/,
    'the helper hash must be recorded at launch');
  assert.equal(result.supervisor_exit, 0);
});

test('workspace.run reports the ceilings it applied and refused', { skip }, async () => {
  const workspace = createWorkspace({ root: join(ROOT, 'ws'), task_id: 'job-seam' });
  workspace.create();
  try {
    const ok = workspace.run({
      command: NODE,
      args: ['-e', 'console.log("from the workspace")'],
      timeoutMs: 20_000,
      maxOutputBytes: 65_536,
      cwd: '.',
    });

    assert.equal(ok.status, 'ok');
    assert.ok(ok.limits_applied.includes('job_time'),
      `the workspace must report what was applied, got ${JSON.stringify(ok.limits_applied)}`);
    assert.deepEqual(ok.limits_refused, []);
    assert.equal(ok.stdout.trim(), 'from the workspace');

    const refused = createWorkspace({
      root: join(ROOT, 'ws-refused'), task_id: 'job-seam-refused',
    });
    refused.create();
    try {
      // A ceiling that cannot be applied must surface as an error status with
      // the refusal attached, never as a run that quietly had no ceiling.
      const refusedRun = refused.run({
        command: join(ROOT, 'no-such-program.exe'),
        args: [],
        timeoutMs: 20_000,
        maxOutputBytes: 65_536,
        cwd: '.',
      });
      assert.equal(refusedRun.status, 'error');
      assert.equal(refusedRun.exit_code, null);
    } finally {
      refused.destroy();
    }

    // The seam's whole reason to exist: a run whose ceilings could not be
    // applied is reported, never quietly executed without them.
    const noHelper = createWorkspace({
      root: join(ROOT, 'ws-nohelper'), task_id: 'job-seam-nohelper',
      helperPath: join(ROOT, 'no-such-job_host.py'),
    });
    noHelper.create();
    try {
      const unchecked = noHelper.run({
        command: NODE, args: ['-e', 'console.log("must not run")'],
        timeoutMs: 20_000, maxOutputBytes: 65_536, cwd: '.',
      });
      assert.equal(unchecked.stdout, '', 'the tool must not have run unenforced');
      assert.equal(unchecked.status, 'error');
      assert.equal(unchecked.limits_applied.length, 0);
      assert.equal(unchecked.limits_refused[0]?.code, 'HELPER_MISSING');
    } finally {
      noHelper.destroy();
    }
  } finally {
    workspace.destroy();
  }
});

test('the helper records a hash and never searches PATH for the interpreter', { skip }, () => {
  assert.ok(existsSync(DEFAULT_HELPER), `the supervisor should exist at ${DEFAULT_HELPER}`);
  assert.equal(resolvePython({ python: 'python.exe' }).ok, false,
    'a bare program name is not an absolute path and must be refused');
  assert.equal(resolvePython({ python: 'C:\\nope\\python.exe' }).ok, false);
  assert.equal(resolvePython({ python: PYTHON.candidate }).ok, true);
});

test('AT-V2-JOB-05 a run in flight is stoppable through the job handle', { skip }, async () => {
  const taskId = 'job-control-live';
  const pending = runInJob({
    command: NODE,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    cwd: ROOT,
    task_id: taskId,
    limits: { job_ms: 60_000 },
    supervisorMs: 30_000,
  });

  // The handle has to appear while the run is still going. Handing it back with
  // the result would be useless for stopping anything.
  const control = await waitForValue(() => createJobControl(taskId), 15_000);
  assert.ok(control, 'the supervisor should be published while it runs');

  const pids = await control.enumerate();
  assert.equal(pids.length, 1, 'one pid is the whole tree');
  assert.ok(pidAlive(pids[0]), 'the published pid should be alive');

  await control.terminate();
  assert.equal(pidAlive(pids[0]), false, 'terminate should not return before it is dead');

  const result = await pending;
  assert.equal(result.status, 'killed_by_supervisor');
  assert.equal(result.killed_by, 'cancel');
  assert.ok(result.duration_ms < 20_000,
    `the run should have been cut short, it took ${result.duration_ms}ms`);
  assert.equal(createJobControl(taskId), null, 'the handle is withdrawn once the run settles');
});

test('AT-V2-JOB-05 control: a task with nothing in flight has no handle', () => {
  assert.equal(createJobControl('nothing-is-running'), null);
});

test('AT-V2-JOB-06 a sleeping tool is bounded by the wall clock, not by job_ms', { skip }, async () => {
  // job_ms is charged in user-mode CPU time, so a tool that sleeps never spends
  // it: a 4.05 s sleep under a 1000 ms job ceiling ran to completion. What binds
  // a sleeping tool is the supervisor's own wall clock - and it has to report
  // `timeout`, because a run nobody cancelled must not be counted as cancelled.
  const result = await runInJob({
    command: NODE,
    args: ['-e', 'setInterval(() => {}, 1000);'],
    cwd: ROOT,
    limits: { job_ms: 60_000 },
    supervisorMs: 2_000,
  });

  assert.equal(result.status, 'timeout');
  assert.equal(result.killed_by, null, 'a wall clock running out is not a cancellation');
  assert.equal(result.kill_reason, 'supervisor_ms');
  assert.ok(result.duration_ms < 60_000, 'job_ms did not end this, the wall clock did');
  assert.deepEqual(result.notifications, [], 'no ceiling fired; this was the backstop');
});

test('AT-V2-JOB-06 control: a run inside the same wall clock completes normally', { skip }, async () => {
  const result = await runInJob({
    command: NODE,
    args: ['-e', 'setTimeout(() => console.log("woke"), 300);'],
    cwd: ROOT,
    limits: { job_ms: 60_000 },
    supervisorMs: 2_000,
  });

  assert.equal(result.status, 'ok', `expected a clean run, got ${result.status}/${result.kill_reason}`);
  assert.equal(result.exit_code, 0);
  assert.equal(result.stdout.trim(), 'woke');
});

test("AT-V2-JOB-07 the supervisor's own wall clock stops a sleeping tool", { skip }, async () => {
  // Two mechanisms can report a timeout and neither stands in for the other.
  // AT-V2-JOB-06 covers Node's timer, which kills the supervisor before it can
  // write anything. This is the helper reaching its own supervisor_ms first: it
  // terminates the job itself and still writes a result.
  const dir = mkdtempSync(join(ROOT, 'host-'));
  const specPath = join(dir, 'spec.json');
  const resultPath = join(dir, 'result.json');
  writeFileSync(specPath, JSON.stringify({
    command: NODE,
    args: ['-e', 'setInterval(() => {}, 1000);'],
    cwd: dir,
    supervisor_ms: 1500,
    output_bytes: 65_536,
  }));

  const started = Date.now();
  const host = spawnSync(PYTHON.candidate,
    [DEFAULT_HELPER, '--spec', specPath, '--result', resultPath],
    { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  const elapsed = Date.now() - started;

  assert.equal(host.status, 0, `the helper still exits cleanly: ${host.stderr}`);
  const written = JSON.parse(readFileSync(resultPath, 'utf8'));
  assert.equal(written.kill_reason, 'supervisor_timeout');
  assert.equal(written.ok, true, 'it terminated the job and reported anyway');
  assert.ok(elapsed < 30_000, 'the backstop must be what ended it, not the test timeout');
  // Terminating the job is what actually killed it, so the tool carries the
  // job's exit code rather than a clean one.
  assert.equal(written.exit_code, EXIT_QUOTA_EXCEEDED);
  assert.ok(await waitFor(() => pidAlive(written.pid) === false, 10_000),
    `tool ${written.pid} outlived its own backstop`);
});

test('AT-V2-JOB-07 control: the same helper spec lets a tool finish inside the backstop', { skip }, () => {
  const dir = mkdtempSync(join(ROOT, 'host-ok-'));
  const specPath = join(dir, 'spec.json');
  const resultPath = join(dir, 'result.json');
  writeFileSync(specPath, JSON.stringify({
    command: NODE,
    args: ['-e', 'console.log("done")'],
    cwd: dir,
    supervisor_ms: 20_000,
    output_bytes: 65_536,
  }));

  const host = spawnSync(PYTHON.candidate,
    [DEFAULT_HELPER, '--spec', specPath, '--result', resultPath],
    { encoding: 'utf8', windowsHide: true, timeout: 30_000 });

  assert.equal(host.status, 0);
  const written = JSON.parse(readFileSync(resultPath, 'utf8'));
  assert.equal(written.kill_reason ?? null, null);
  assert.equal(written.exit_code, 0);
  assert.equal(written.stdout.trim(), 'done');
});

test('AT-V2-JOB-08 a job_memory ceiling is enforced, and posts its own notification', { skip }, () => {
  // Contract 1 does not expose job_memory_bytes, so this drives the helper the
  // way the ceiling would be used if it ever were: the whole-job commit limit,
  // which is a different limit from the per-process one and posts a different
  // notification. That difference is the only reason to have both.
  const dir = mkdtempSync(join(ROOT, 'jmem-'));
  const specPath = join(dir, 'spec.json');
  const resultPath = join(dir, 'result.json');
  writeFileSync(specPath, JSON.stringify({
    command: NODE,
    args: ['-e', ALLOC_OVER],
    cwd: dir,
    job_memory_bytes: 256 * 1024 * 1024,
    supervisor_ms: 20_000,
    output_bytes: 65_536,
  }));

  const host = spawnSync(PYTHON.candidate,
    [DEFAULT_HELPER, '--spec', specPath, '--result', resultPath],
    { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  assert.equal(host.status, 0, `the helper still exits cleanly: ${host.stderr}`);

  const written = JSON.parse(readFileSync(resultPath, 'utf8'));
  assert.deepEqual(written.limits_applied, ['job_memory']);
  assert.deepEqual(written.limits_refused, []);
  const names = written.notifications.map((note) => note.name);
  assert.ok(names.includes('JOB_MEMORY_LIMIT'), `expected JOB_MEMORY_LIMIT, got ${JSON.stringify(names)}`);
  assert.equal(names.includes('PROCESS_MEMORY_LIMIT'), false, 'these ceilings must not be confused');
  assert.equal(written.stdout.includes('allocated'), false, 'the tool should not have finished');
});

test('AT-V2-JOB-08 control: a run under the same job_memory ceiling completes', { skip }, () => {
  const dir = mkdtempSync(join(ROOT, 'jmem-ok-'));
  const specPath = join(dir, 'spec.json');
  const resultPath = join(dir, 'result.json');
  writeFileSync(specPath, JSON.stringify({
    command: NODE,
    args: ['-e', ALLOC_UNDER],
    cwd: dir,
    job_memory_bytes: 256 * 1024 * 1024,
    supervisor_ms: 20_000,
    output_bytes: 65_536,
  }));

  const host = spawnSync(PYTHON.candidate,
    [DEFAULT_HELPER, '--spec', specPath, '--result', resultPath],
    { encoding: 'utf8', windowsHide: true, timeout: 30_000 });

  assert.equal(host.status, 0);
  const written = JSON.parse(readFileSync(resultPath, 'utf8'));
  assert.equal(written.exit_code, 0);
  assert.equal(written.stdout.trim(), 'allocated 2');
  assert.equal(written.notifications.some((note) => note.name === 'JOB_MEMORY_LIMIT'), false);
});

test('both timeout shapes report timeout, and neither borrows the word cancel', () => {
  const base = { supervisorExit: 0, killedByCaller: false, timedOut: false };

  // Node's timer got there first, so there is no result to read.
  assert.deepEqual(deriveOutcome({ ...base, result: null, wallClockExpired: true }),
    { status: 'timeout', killed_by: null, kill_reason: 'supervisor_ms' });

  // The helper got there first and wrote its own account.
  assert.deepEqual(deriveOutcome({ ...base, result: { ok: true, kill_reason: 'supervisor_timeout' } }),
    { status: 'timeout', killed_by: null, kill_reason: 'supervisor_timeout' });

  // A real cancellation still says so - this is the difference the labels exist
  // to keep, because cancel.mjs counts a `cancel` as a tool this process
  // stopped and must not count a timeout as one.
  assert.deepEqual(deriveOutcome({ ...base, result: null, killedByCaller: true }),
    { status: 'killed_by_supervisor', killed_by: 'cancel', kill_reason: 'cancel' });

  // A kernel notification outranks the helper's own account of itself, and it
  // outranks it even when the helper also recorded a timeout.
  assert.deepEqual(deriveOutcome({
    ...base,
    result: { ok: true, kill_reason: 'supervisor_timeout', notifications: [{ name: 'PROCESS_MEMORY_LIMIT' }] },
  }), { status: 'killed_by_job', killed_by: 'process_memory', kill_reason: 'job_notification:process_memory' });
});

test('the ceiling table states the truth about every ceiling', () => {
  assert.deepEqual(CEILINGS.map((c) => c.name),
    ['max_processes', 'process_memory', 'job_time', 'output_bytes', 'tool_calls']);

  for (const ceiling of CEILINGS) {
    assert.ok(['job_object', 'timer', 'buffer', 'counter', 'none'].includes(ceiling.enforced_by),
      `${ceiling.name} has an unknown enforcement: ${ceiling.enforced_by}`);
    assert.equal(typeof ceiling.mechanism, 'string');
    assert.ok(ceiling.mechanism.length > 0, `${ceiling.name} must explain its mechanism`);
    assert.ok(ceiling.measured === null || typeof ceiling.measured === 'string',
      `${ceiling.name}.measured must be a description or null`);
  }

  // The process ceiling cannot be delegated to the job API, and the reason has
  // to name the error rather than gesture at it.
  const processes = CEILINGS.find((c) => c.name === 'max_processes');
  assert.equal(processes.enforced_by, 'none');
  assert.match(processes.mechanism, /ERROR_NOT_ENOUGH_QUOTA/);
  assert.match(processes.mechanism, /1816/);
  assert.ok(unenforcedCeilings().includes('max_processes'));

  // The tool-call ceiling is a real counter now, and the row has to keep saying
  // how far it reaches: 0 refuses, a positive value is never spent up to.
  const calls = CEILINGS.find((c) => c.name === 'tool_calls');
  assert.equal(calls.enforced_by, 'counter');
  assert.match(calls.mechanism, /task-runner\.mjs/);
  assert.match(calls.mechanism, /one invocation/);
  assert.match(calls.measured, /BUDGET_EXCEEDED/);
  assert.deepEqual(unenforcedCeilings(), ['max_processes']);

  // "We configured it and never checked" must not render like "enforced".
  assert.equal(renderCeiling({ name: 'x', enforced_by: 'timer', measured: null }),
    'x: enforced_by=timer - configured, not measured');
  assert.equal(describeCeilings().length, CEILINGS.length);
});
