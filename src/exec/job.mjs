/**
 * Run one tool process inside a Windows job object, through tools/win32/job_host.py.
 *
 * The helper is a supervisor, not a launcher: it holds the job handle with
 * KILL_ON_JOB_CLOSE set, so if the supervisor dies for any reason the kernel
 * reaps every process still in the job. From here the whole tree is one pid.
 *
 * Nothing in this module guesses whether a ceiling fired. A verdict is taken
 * from the job notification the kernel posted, or from the supervisor's own
 * account of what it had to do - never from a bare exit code. A tool that
 * exits 0xC0000044 for its own reasons is not the same event as the job
 * stopping it, and the two must not read the same in a log.
 *
 * Lain is not a sandbox. This bounds resource use; it does not confine what a
 * tool is able to do.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** STATUS_QUOTA_EXCEEDED: what the job writes when a limit ends a process. */
export const EXIT_QUOTA_EXCEEDED = 0xc0000044;

export const DEFAULT_SUPERVISOR_MS = 300_000;
export const DEFAULT_OUTPUT_BYTES = 1_048_576;

/** Absolute, and never searched for on PATH: absence is a refusal, not a fallback. */
export const DEFAULT_PYTHON = 'C:\\Python315\\python.exe';

export const DEFAULT_HELPER = resolve(HERE, '..', '..', 'tools', 'win32', 'job_host.py');

// The cancel path asks this layer for a job handle while a tool is still
// running, so the supervisor pid is published the moment it exists. Handing it
// back with the result would be useless for stopping anything.
/** @type {Map<string, {pid: number, kill: () => boolean}>} */
const liveRuns = new Map();

/** @param {number} pid */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The execution layer's job handle for a task, or null when nothing is in
 * flight. Null is not the same answer as zero survivors: an `indeterminate`
 * task whose handle is missing has an unknown number of processes, and
 * src/agent/cancel.mjs is the place that decides so.
 *
 * @param {string} taskId
 * @returns {{enumerate: () => number[], terminate: () => Promise<void>}|null}
 */
export function createJobControl(taskId) {
  const run = liveRuns.get(taskId);
  if (!run || !alive(run.pid)) return null;

  return {
    // One pid, because one pid is the whole tree: the tool is inside the job
    // and the supervisor holds the handle with KILL_ON_JOB_CLOSE set.
    enumerate: () => (alive(run.pid) ? [run.pid] : []),
    terminate: async () => {
      // Through the run's own kill, not process.kill: the run has to learn the
      // kill was deliberate, or it reports the loss of its supervisor as a
      // spawn failure.
      run.kill();
      for (let i = 0; i < 100 && alive(run.pid); i += 1) {
        await new Promise((done) => setTimeout(done, 50));
      }
    },
  };
}

/** Which ceiling each job notification is evidence for. @type {Record<string, string>} */
const KILLED_BY_NOTIFICATION = {
  END_OF_JOB_TIME: 'job_time',
  END_OF_PROCESS_TIME: 'job_time',
  PROCESS_MEMORY_LIMIT: 'process_memory',
  JOB_MEMORY_LIMIT: 'job_memory',
};

/**
 * @param {string} path
 * @returns {string|null}
 */
function sha256File(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * @param {string} limit
 * @param {string} code
 * @param {string} detail
 */
function refusal(limit, code, detail) {
  return { limit, code, detail };
}

/**
 * Resolve the interpreter by explicit absolute path. There is deliberately no
 * PATH lookup: a machine without the interpreter must fail closed and say so,
 * rather than run the tool with nothing enforced.
 *
 * @param {{python?: string}} [spec]
 */
export function resolvePython(spec = {}) {
  const candidate = spec.python ?? process.env.LAIN_PYTHON ?? DEFAULT_PYTHON;
  if (!/^[a-zA-Z]:[\\/]/.test(candidate)) {
    return { ok: false, candidate, reason: 'the interpreter path is not absolute' };
  }
  if (!existsSync(candidate)) {
    return { ok: false, candidate, reason: 'the interpreter is not present at that path' };
  }
  return { ok: true, candidate };
}

/**
 * Build the spec the supervisor reads. Only ceilings that were actually asked
 * for are sent, so the helper never reports enforcing a limit nobody set.
 *
 * @param {Record<string, any>} spec
 * @param {number} supervisorMs
 */
export function buildHelperSpec(spec, supervisorMs) {
  const limits = spec.limits ?? {};
  /** @type {Record<string, any>} */
  const out = {
    command: spec.command,
    args: spec.args ?? [],
    cwd: spec.cwd,
    output_bytes: spec.outputBytes ?? DEFAULT_OUTPUT_BYTES,
    supervisor_ms: supervisorMs,
  };
  if (spec.env) out.env = spec.env;
  if (limits.process_memory_bytes) out.process_memory_bytes = limits.process_memory_bytes;
  if (limits.job_memory_bytes) out.job_memory_bytes = limits.job_memory_bytes;
  if (limits.job_ms) out.job_ms = limits.job_ms;
  return out;
}

/**
 * Everything both the asynchronous and the synchronous path need before
 * spawning: an interpreter that exists, a helper that exists, and a scratch
 * directory. Any missing piece becomes a refusal the caller must report.
 *
 * @param {Record<string, any>} [spec]
 */
export function prepareRun(spec = {}) {
  const supervisorMs = spec.supervisorMs ?? DEFAULT_SUPERVISOR_MS;
  const helperPath = spec.helperPath ?? DEFAULT_HELPER;
  /** @type {{limit: string, code: string, detail: string}[]} */
  const refusals = [];
  const helperSha256 = sha256File(helperPath);

  if (helperSha256 === null) {
    refusals.push(refusal('job_object', 'HELPER_MISSING',
      `the job supervisor is not readable at ${helperPath}`));
  }

  const python = resolvePython(spec);
  if (!python.ok) {
    refusals.push(refusal('job_object', 'INTERPRETER_MISSING',
      `${python.reason}: ${python.candidate}`));
  }

  return { supervisorMs, helperPath, helperSha256, python, refusals, ready: refusals.length === 0 };
}

/**
 * A refusal is returned, never thrown: an unenforced run must stay visible.
 *
 * @param {Record<string, any>} prep
 * @param {Record<string, any>} spec
 * @param {number} startedAt
 */
function refusedResult(prep, spec, startedAt) {
  return {
    pid: null,
    job_name: 'lain-tool-unstarted',
    limits_applied: [],
    limits_refused: prep.refusals,
    stdout: '',
    stderr: '',
    output_truncated: false,
    exit_code: null,
    status: 'spawn_failed',
    killed_by: null,
    kill_reason: prep.refusals[0]?.code?.toLowerCase() ?? 'refused',
    duration_ms: Date.now() - startedAt,
    supervisor_exit: null,
    supervisor_ms: prep.supervisorMs,
    helper_sha256: prep.helperSha256,
    notifications: [],
    readback: {},
    spec: spec.name ?? null,
    spawn_error: null,
    error_code: prep.refusals[0]?.code ?? 'HELPER_UNAVAILABLE',
  };
}

/**
 * @param {string} [dir]
 */
function scratch(dir) {
  const path = mkdtempSync(join(dir ?? tmpdir(), 'lain-job-'));
  return {
    path,
    specPath: join(path, 'spec.json'),
    resultPath: join(path, 'result.json'),
    cleanup() {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {
        // A scratch directory that will not delete is not worth failing a run
        // over; the OS temp cleaner owns it now.
      }
    },
  };
}

/**
 * @param {string} resultPath
 */
function readResult(resultPath) {
  if (!existsSync(resultPath)) return null;
  try {
    return JSON.parse(readFileSync(resultPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Decide what happened from evidence, in order of how directly it proves the
 * claim. The notification the kernel posted outranks the exit code; the
 * supervisor's own account of what it had to do outranks both.
 *
 * @param {{result: any, supervisorExit: number|null, killedByCaller: boolean, timedOut: boolean}} run
 */
export function deriveOutcome({ result, supervisorExit, killedByCaller, timedOut }) {
  if (killedByCaller) {
    return { status: 'killed_by_supervisor', killed_by: 'cancel', kill_reason: 'cancel' };
  }
  if (timedOut) {
    return { status: 'timeout', killed_by: 'cancel', kill_reason: 'supervisor_ms' };
  }
  if (!result || result.ok !== true) {
    return {
      status: 'spawn_failed',
      killed_by: null,
      kill_reason: result?.fatal ? 'helper_fatal' : 'no_result',
    };
  }

  const notifications = Array.isArray(result.notifications) ? result.notifications : [];
  /** @type {string[]} */
  const notified = [];
  for (const note of notifications) {
    const ceiling = KILLED_BY_NOTIFICATION[String(note?.name)];
    if (ceiling) notified.push(ceiling);
  }

  if (notified.length > 0) {
    return {
      status: 'killed_by_job',
      killed_by: notified[0],
      kill_reason: `job_notification:${notified[0]}`,
    };
  }

  if (result.kill_reason === 'supervisor_timeout') {
    return { status: 'timeout', killed_by: 'cancel', kill_reason: 'supervisor_timeout' };
  }
  if (result.kill_reason === 'output_ceiling') {
    return { status: 'killed_by_supervisor', killed_by: null, kill_reason: 'output_ceiling' };
  }

  const code = result.exit_code;
  if (code === EXIT_QUOTA_EXCEEDED) {
    // The contract's other arm: quota-exceeded with no notification. Kept, but
    // named separately so it never reads like a notified kill.
    return { status: 'killed_by_job', killed_by: 'job_time', kill_reason: 'exit_quota_exceeded' };
  }
  if (code === 0) {
    return { status: 'ok', killed_by: null, kill_reason: null };
  }
  if (supervisorExit !== 0 && code === undefined) {
    return { status: 'spawn_failed', killed_by: null, kill_reason: 'supervisor_failed' };
  }
  return { status: 'exit_nonzero', killed_by: null, kill_reason: null };
}

/**
 * @param {Record<string, any>} prep
 * @param {Record<string, any>} spec
 * @param {Record<string, any>} run
 * @param {Record<string, any>} extra
 */
function assemble(prep, spec, run, extra) {
  const result = run.result;
  const outcome = deriveOutcome({
    result,
    supervisorExit: run.supervisorExit,
    killedByCaller: run.killedByCaller,
    timedOut: run.timedOut,
  });

  return {
    pid: result?.pid ?? null,
    job_name: result?.job_name ?? 'lain-tool-unstarted',
    limits_applied: result?.limits_applied ?? [],
    limits_refused: [...prep.refusals, ...(result?.limits_refused ?? [])],
    stdout: result?.stdout ?? '',
    stderr: result?.stderr || extra.supervisorStderr || '',
    output_truncated: result?.output_truncated ?? false,
    exit_code: result?.exit_code ?? null,
    status: outcome.status,
    killed_by: outcome.killed_by,
    kill_reason: outcome.kill_reason,
    duration_ms: Date.now() - run.startedAt,
    supervisor_exit: run.supervisorExit,
    supervisor_ms: prep.supervisorMs,
    helper_sha256: prep.helperSha256,
    notifications: result?.notifications ?? [],
    readback: result?.readback ?? {},
    spec: spec.name ?? null,
    spawn_error: result?.spawn_error ?? null,
    error_code: outcome.status === 'ok' || outcome.status === 'exit_nonzero'
      ? null
      : result?.spawn_error_code ?? prep.refusals[0]?.code ?? outcome.kill_reason,
  };
}

/**
 * @param {ReturnType<typeof scratch>} dir
 * @param {Record<string, any>} spec
 * @param {number} supervisorMs
 */
function writeSpec(dir, spec, supervisorMs) {
  writeFileSync(dir.specPath, JSON.stringify(buildHelperSpec(spec, supervisorMs), null, 2));
}

/**
 * @param {Record<string, any>} prep
 * @param {ReturnType<typeof scratch>} dir
 * @param {Record<string, any>} spec
 */
function spawnSupervisor(prep, dir, spec) {
  return new Promise((resolvePromise) => {
    const child = spawn(prep.python.candidate,
      [prep.helperPath, '--spec', dir.specPath, '--result', dir.resultPath],
      {
        cwd: spec.supervisorCwd ?? process.cwd(),
        env: spec.supervisorEnv ?? process.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

    let supervisorStderr = '';
    child.stderr.on('data', (chunk) => {
      supervisorStderr += chunk.toString('utf8');
    });
    child.stdout.resume();

    let killedByCaller = false;
    // Only a kill that actually landed counts as deliberate. If the supervisor
    // has already exited, child.kill() returns false and the run keeps whatever
    // result it wrote — otherwise a race with its own exit would relabel a
    // finished run as cancelled.
    const kill = () => {
      if (child.kill()) killedByCaller = true;
      return killedByCaller;
    };

    const taskId = typeof spec.task_id === 'string' ? spec.task_id : null;
    if (taskId !== null && typeof child.pid === 'number') {
      liveRuns.set(taskId, { pid: child.pid, kill });
    }
    const release = () => {
      if (taskId !== null && liveRuns.get(taskId)?.pid === child.pid) liveRuns.delete(taskId);
    };

    const timer = setTimeout(kill, prep.supervisorMs);
    timer.unref?.();

    child.on('error', () => {
      clearTimeout(timer);
      release();
      resolvePromise({
        result: null,
        supervisorExit: null,
        killedByCaller,
        timedOut: false,
        supervisorStderr,
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      release();
      resolvePromise({
        result: readResult(dir.resultPath),
        supervisorExit: code,
        killedByCaller,
        timedOut: false,
        supervisorStderr,
      });
    });
  });
}

/**
 * Run a tool under job-object ceilings. Never throws for an ordinary failure:
 * a run that could not be enforced comes back as `spawn_failed` with the
 * refusal recorded, because a silent fallback to unenforced execution is the
 * one outcome this seam exists to prevent.
 *
 * @param {Record<string, any>} spec
 */
export async function runInJob(spec) {
  const startedAt = Date.now();
  const prep = prepareRun(spec);
  if (!prep.ready) return refusedResult(prep, spec, startedAt);

  const dir = scratch(spec.tmpDir);
  try {
    writeSpec(dir, spec, prep.supervisorMs);
    const run = await spawnSupervisor(prep, dir, spec);
    return assemble(prep, spec, { ...run, startedAt }, {});
  } finally {
    dir.cleanup();
  }
}

/**
 * The synchronous shape of the same seam. src/tools/run-script.mjs calls the
 * workspace synchronously and that call site is not ours to make async, so
 * both shapes exist rather than one being faked with a deasync trick.
 *
 * @param {Record<string, any>} spec
 */
export function runInJobSync(spec) {
  const startedAt = Date.now();
  const prep = prepareRun(spec);
  if (!prep.ready) return refusedResult(prep, spec, startedAt);

  const dir = scratch(spec.tmpDir);
  try {
    writeSpec(dir, spec, prep.supervisorMs);
    const completed = spawnSync(prep.python.candidate,
      [prep.helperPath, '--spec', dir.specPath, '--result', dir.resultPath],
      {
        cwd: spec.supervisorCwd ?? process.cwd(),
        env: spec.supervisorEnv ?? process.env,
        windowsHide: true,
        encoding: 'utf8',
        timeout: prep.supervisorMs,
      });

    return assemble(prep, spec, {
      result: readResult(dir.resultPath),
      supervisorExit: completed.status,
      killedByCaller: false,
      timedOut: isTimeoutError(completed.error),
      startedAt,
    }, { supervisorStderr: completed.stderr ?? '' });
  } finally {
    dir.cleanup();
  }
}

/**
 * spawnSync reports a timeout by setting `code` on the Error it returns, and
 * that property is not part of the Error type - so it is read through a shape
 * that has it, rather than by widening the value to any.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
function isTimeoutError(error) {
  const code = /** @type {{code?: string}|null|undefined} */ (error)?.code;
  return code === 'ETIMEDOUT';
}
