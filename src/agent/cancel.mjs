// Cancellation cascade — Model C, hybrid by effect class.
//
// `cancelling` and `cancel_failed` are states in the task machine that nothing
// could reach. This module is the only thing that opens those edges, and it
// exists so that "it stopped" is a claim somebody can check rather than one
// somebody can assert.
//
// Two invariants hold everywhere below. The terminal intent row is written
// before any kill, so a crash between the decision and the effect still leaves a
// record of what was supposed to happen. And nothing is reported as stopped
// unless an enumeration was read and came back empty — anything else settles as
// `cancel_failed` with the count in the evidence. I did not add a path that
// rounds an unreadable answer down to zero; the refusal is the feature.
//
// The kill belongs to the execution layer, which owns the job object, so it
// arrives here as a port: `jobControl(taskId) -> JobControl | null`. Returning
// `null` is a claim that the task owns no live job. Until `src/exec/job.mjs`
// supplies the real one I run against an injected port; wiring it in replaces
// the injection and changes nothing here.
//
// `requestCancellation` is idempotent: a second call, concurrent or after a
// restart, returns the first request rather than opening a second one.
import { existsSync, readdirSync, renameSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { LainError } from '../core/errors.mjs';
import { ulid } from '../core/ids.mjs';
import { EFFECT_CLASSES } from '../policy/arms.mjs';
import '../core/types.mjs';

/**
 * What each effect class does to in-flight work.
 * @type {Readonly<Record<string, string>>}
 */
export const CANCEL_ACTIONS = Object.freeze({
  read_only: 'stop_at_safe_point',
  local_reversible: 'kill_then_record_writes',
  local_transactional: 'kill_then_mark_unusable',
  external: 'escalate_no_kill',
  local_irreversible: 'escalate_no_kill',
});

/** An unrecognised class is treated as `external`: ask, never guess. */
export const UNKNOWN_EFFECT_ACTION = 'escalate_no_kill';

/**
 * Every state a cancellation request may act on, which is every non-terminal
 * state. `submitted` is included because a task that exists and was never
 * admitted still has to be stoppable: refusing leaves it running until a runner
 * gets around to starting it. `indeterminate` is included because a task nobody
 * can stop is worse than one that stops with an honest account of what could not
 * be proved — and what that state can conclude is limited below, in code.
 */
export const CANCELLABLE_STATES = Object.freeze(['submitted', 'admitted', 'running', 'indeterminate']);

/**
 * The terminal four, plus `cancelling`, which is handled before this list is
 * consulted. A second cancel on a terminal task is recorded as ignored, not
 * refused; a task already stopping does not need a second stop.
 */
export const NON_CANCELLABLE_STATES = Object.freeze(['cancelling', 'completed', 'failed', 'cancelled', 'cancel_failed']);

/**
 * Why a human is being asked, per class.
 * @type {Readonly<Record<string, string>>}
 */
const ESCALATION_DETAIL = Object.freeze({
  external: 'the effect left local control, so only the adapter that made the attempt can report its outcome',
  local_irreversible: 'the step destroys or overwrites state that cannot be reconstructed, so a human decides when it stops',
  unknown: 'the effect class is unknown, and the cascade refuses to guess about an effect it cannot classify',
});

/** Restated so the cascade does not need a second import to name them. */
const TERMINAL_STATES = Object.freeze(['completed', 'failed', 'cancelled', 'cancel_failed']);

export class CancelError extends LainError {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [detail]
   */
  constructor(code, message, detail = {}) {
    super(code, message, detail);
    this.name = 'CancelError';
  }
}

/**
 * @typedef {object} JobControl
 * @property {() => number[] | Promise<number[]>} enumerate live pids in the job, read from the OS
 * @property {() => void | Promise<void>} terminate kill the process tree
 * @property {(() => void | Promise<void>)} [requestStop] cooperative stop, for classes that stop at a safe point
 */

/**
 * @typedef {{recorded: boolean, detail: string, files: {path: string, bytes: number}[]}} WritesRecord
 * @typedef {{scope: string, renamed: {from: string, to: string}[], failed: {path: string, code: string}[]}} QuarantineRecord
 */

/**
 * @typedef {object} CancelRequest
 * @property {string|null} request_id
 * @property {string} task_id
 * @property {string} requested_by
 * @property {string} reason
 * @property {string} reason_code
 * @property {string} requested_at
 * @property {string} effect_class
 * @property {boolean} class_known
 * @property {string} action
 * @property {number} deadline_ms
 * @property {string} status
 * @property {string|null} state
 * @property {number|null} survivors
 * @property {number[]|null} survivor_pids
 * @property {string|null} survivors_verified_by
 * @property {boolean} kill_attempted
 * @property {boolean} stop_requested
 * @property {boolean} escalated
 * @property {string|null} human_action_required
 * @property {{recorded: boolean, detail: string, files: {path: string, bytes: number}[]}|null} writes
 * @property {{scope: string, renamed: {from: string, to: string}[], failed: {path: string, code: string}[]}|null} quarantined
 * @property {string[]} events
 * @property {boolean} result_recorded
 * @property {boolean} replayed
 * @property {boolean} deadline_exceeded
 */

/**
 * Classify an effect class into the action the cascade will take. The caller
 * supplies a class, never a decision.
 *
 * I honour `effect_class_known` explicitly rather than inferring it from the
 * normalised value. Task admission normalises an unrecognised class to
 * `external`, which is the right stored value and the wrong thing to reason
 * from, because it erases the fact that nobody knew what this tool does.
 *
 * @param {{effect_class?: unknown, effect_class_known?: unknown}} [input]
 * @returns {{effect_class: string, class_known: boolean, action: string, kills: boolean, escalation_detail: string|null}}
 */
export function classifyCancellation(input = {}) {
  const raw = input.effect_class;
  const member = typeof raw === 'string' && EFFECT_CLASSES.includes(raw);
  const classKnown = member && input.effect_class_known !== false;
  const effectClass = member ? /** @type {string} */ (raw) : 'external';
  const action = classKnown ? CANCEL_ACTIONS[effectClass] ?? UNKNOWN_EFFECT_ACTION : UNKNOWN_EFFECT_ACTION;
  const kills = action === 'kill_then_record_writes' || action === 'kill_then_mark_unusable';
  return {
    effect_class: effectClass,
    class_known: classKnown,
    action,
    kills,
    escalation_detail: action === 'escalate_no_kill' ? detailFor(effectClass, classKnown) : null,
  };
}

/**
 * @param {string} effectClass
 * @param {boolean} classKnown
 * @returns {string}
 */
function detailFor(effectClass, classKnown) {
  if (!classKnown) return ESCALATION_DETAIL.unknown ?? 'the effect class is unknown';
  return ESCALATION_DETAIL[effectClass] ?? 'this class is never killed without a human';
}

/**
 * @param {Partial<CancelRequest>} overrides
 * @returns {CancelRequest}
 */
function baseRequest(overrides) {
  return {
    request_id: null,
    task_id: '',
    requested_by: 'unspecified',
    reason: '',
    reason_code: '',
    requested_at: '',
    effect_class: '',
    class_known: false,
    action: '',
    deadline_ms: 0,
    status: 'cancel_failed',
    state: null,
    survivors: null,
    survivor_pids: null,
    survivors_verified_by: null,
    kill_attempted: false,
    stop_requested: false,
    escalated: false,
    human_action_required: null,
    writes: null,
    quarantined: null,
    events: [],
    result_recorded: false,
    replayed: false,
    deadline_exceeded: false,
    ...overrides,
  };
}

/**
 * Every file inside the workspace, by relative path. Mirrors the walk the
 * workspace handle does, so "what was written" is the same list whichever side
 * of the boundary reports it.
 *
 * @param {string} dir
 * @returns {{path: string, bytes: number}[]}
 */
function listFiles(dir) {
  /** @type {{path: string, bytes: number}[]} */
  const out = [];
  /** @param {string} current */
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push({ path: relative(dir, full).split(sep).join('/'), bytes: statSync(full).size });
    }
  };
  walk(dir);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Mark a partial write unusable without deleting it. The artifact keeps its
 * bytes and loses its name, so a consumer looking for the file it expected does
 * not find a half-written one and mistake it for a finished one. Deleting it
 * would destroy the evidence of what the stopped work had already done.
 *
 * @param {string} dir
 * @param {{path: string}[]} files
 * @param {string} requestId
 * @returns {{scope: string, renamed: {from: string, to: string}[], failed: {path: string, code: string}[]}}
 */
function markUnusable(dir, files, requestId) {
  /** @type {{from: string, to: string}[]} */
  const renamed = [];
  /** @type {{path: string, code: string}[]} */
  const failed = [];
  for (const file of files) {
    const from = join(dir, file.path);
    const plain = `${from}.partial-unusable`;
    const suffixed = `${from}.partial-unusable.${requestId.slice(-6)}`;
    const target = existsSync(plain) ? suffixed : plain;
    try {
      renameSync(from, target);
      renamed.push({ from: file.path, to: relative(dir, target).split(sep).join('/') });
    } catch (err) {
      failed.push({ path: file.path, code: /** @type {NodeJS.ErrnoException} */ (err).code ?? 'RENAME_FAILED' });
    }
  }
  return { scope: 'every file the task wrote in its workspace', renamed, failed };
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function messageOf(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Race work against the cancellation deadline. A timeout never resolves into a
 * success: it rejects, so the caller has to decide what a deadline means.
 *
 * @template T
 * @param {Promise<T>} work
 * @param {number} ms
 * @returns {Promise<T>}
 */
function withDeadline(work, ms) {
  if (!Number.isFinite(ms) || ms <= 0) return work;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let timer = null;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new CancelError('CANCEL_DEADLINE_EXCEEDED', `the cancellation deadline of ${ms} ms passed`));
    }, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * What a caller may pass to requestCancellation.
 *
 * @typedef {object} CancelOptions
 * @property {string} [reason] why, in prose, for the human reading the log later
 * @property {string} [reason_code] the machine-readable form of the same thing
 * @property {string} [requested_by] who asked. Required: the record must show it.
 * @property {string} [effect_class] overrides the class recorded on the task
 * @property {boolean} [effect_class_known] whether that class is a real one
 * @property {number} [deadline_ms] how long the cascade may take before a human is called
 */

/**
 * The cascade's own handle.
 *
 * @typedef {object} Canceller
 * @property {(taskId: string, options?: CancelOptions) => Promise<CancelRequest>} requestCancellation
 * @property {(taskId: string) => Promise<CancelRequest>|null} settled the open request, if any
 * @property {() => number} pending how many cancellations are open right now
 */

/**
 * The cancellation cascade for one task store, one event log and one job port.
 *
 * @param {object} args
 * @param {import('../core/types.mjs').TaskStore} args.taskStore
 * @param {(info: {task_id: string}) => import('../core/types.mjs').EventLog} [args.openLog]
 * @param {(task_id: string) => JobControl|null} [args.jobControl] the execution layer's job handle
 * @param {(task_id: string) => string|null} [args.workspaceFor] overrides the workspace lookup
 * @param {string|null} [args.workspaceRoot] root whose `<root>/<task_id>` is the workspace
 * @param {() => number} [args.now]
 * @param {number} [args.deadlineMs]
 * @param {(request: CancelRequest) => void} [args.escalate] a notification hook; never a decision
 * @returns {Canceller}
 */
export function createCanceller({
  taskStore,
  openLog,
  jobControl,
  workspaceFor,
  workspaceRoot = null,
  now = Date.now,
  deadlineMs = 30_000,
  escalate,
}) {
  /** @type {Map<string, Promise<CancelRequest>>} */
  const inFlight = new Map();

  /**
   * @param {string} taskId
   * @returns {string|null}
   */
  function workspaceDir(taskId) {
    if (typeof workspaceFor === 'function') {
      const chosen = workspaceFor(taskId);
      if (typeof chosen === 'string' && chosen.length > 0) return chosen;
    }
    if (typeof workspaceRoot === 'string' && workspaceRoot.length > 0) return join(workspaceRoot, taskId);
    return null;
  }

  /**
   * The request that a previous call opened, read back from the event log. This
   * is what makes idempotency survive a restart: the answer comes from the
   * durable record, not from this process's memory.
   *
   * @param {import('../core/types.mjs').EventLog|null} log
   * @param {string} taskId
   * @returns {Record<string, unknown>|null}
   */
  function priorRequest(log, taskId) {
    if (!log || typeof log.read !== 'function') return null;
    try {
      const rows = /** @type {{payload?: Record<string, unknown>}[]} */ (log.read({ task_id: taskId, event_type: 'task.cancel.requested', limit: 1 }));
      const first = rows[0];
      return first && first.payload ? first.payload : null;
    } catch {
      return null;
    }
  }

  /**
   * @param {string} taskId
   * @param {{reason?: string, reason_code?: string, requested_by?: string, effect_class?: string, effect_class_known?: boolean, deadline_ms?: number}} options
   * @returns {Promise<CancelRequest>}
   */
  async function perform(taskId, options) {
    const reason = typeof options.reason === 'string' && options.reason.length > 0 ? options.reason : 'no reason given';
    const reasonCode = typeof options.reason_code === 'string' && options.reason_code.length > 0 ? options.reason_code : 'CANCEL_REQUESTED';
    const requestedBy = options.requested_by;
    if (typeof requestedBy !== 'string' || requestedBy.length === 0) {
      // "any -> cancelling without a request event" is illegal: the record has to
      // show who asked. An unnamed cancellation is refused rather than recorded
      // under a name nobody chose.
      throw new CancelError('REQUESTED_BY_REQUIRED', 'a cancellation must name who asked: pass { requested_by }');
    }

    const task = taskStore.get(taskId);
    const log = openLog ? openLog({ task_id: taskId }) : null;
    /** @type {string[]} */
    const events = [];
    const startedAt = new Date(now()).toISOString();
    let requestId = null;

    /**
     * @param {string} eventType
     * @param {Record<string, unknown>} payload
     * @param {string|null} [correlation]
     */
    const write = (eventType, payload, correlation = null) => {
      events.push(eventType);
      if (!log) return;
      log.record(eventType, payload, correlation ? { task_id: taskId, correlation_id: correlation } : { task_id: taskId });
    };

    const state = task.state;

    // A task that already stopped: a second cancel is a no-op that is recorded.
    if (TERMINAL_STATES.includes(state)) {
      const prior = priorRequest(log, taskId);
      write('task.cancel.ignored', { reason_code: 'TERMINAL_IS_TERMINAL', state, task_id: taskId });
      if (prior) {
        return baseRequest({ .../** @type {Partial<CancelRequest>} */ (prior), task_id: taskId, status: state === 'cancelled' ? 'cancelled' : 'cancel_failed', state, events, replayed: true });
      }
      return baseRequest({
        task_id: taskId,
        requested_by: requestedBy,
        reason,
        reason_code: reasonCode,
        requested_at: startedAt,
        status: 'ignored',
        state,
        events,
        human_action_required: null,
      });
    }

    // A cancellation already running: this process, another one, or before a crash.
    if (state === 'cancelling') {
      const prior = priorRequest(log, taskId);
      write('task.cancel.ignored', { reason_code: 'ALREADY_CANCELLING', state, task_id: taskId });
      if (prior) {
        return baseRequest({ .../** @type {Partial<CancelRequest>} */ (prior), task_id: taskId, status: 'in_flight', state, events, replayed: true });
      }
      return baseRequest({
        task_id: taskId,
        requested_by: requestedBy,
        reason,
        reason_code: reasonCode,
        requested_at: startedAt,
        status: 'in_flight',
        state,
        events,
        human_action_required: 'the task is already cancelling but no request event could be read back',
      });
    }

    // Refuse unclassified states rather than forging a transition.
    if (NON_CANCELLABLE_STATES.includes(state) || !CANCELLABLE_STATES.includes(state)) {
      const from = state;
      write('task.cancel.refused', {
        reason_code: 'ILLEGAL_TRANSITION',
        from,
        to: 'cancelling',
        cancellable_from: [...CANCELLABLE_STATES],
        task_id: taskId,
      });
      return baseRequest({
        task_id: taskId,
        requested_by: requestedBy,
        reason,
        reason_code: reasonCode,
        requested_at: startedAt,
        status: 'refused',
        state: from,
        events,
        human_action_required: `cancellation from "${from}" is not a legal transition in this milestone`,
      });
    }

    requestId = ulid(now());
    const effectiveDeadline = Number.isFinite(options.deadline_ms) ? /** @type {number} */ (options.deadline_ms) : deadlineMs;
    const declaredClass = options.effect_class ?? task.effect_class;
    const declaredKnown = options.effect_class === undefined ? task.contract.effect_class_known : options.effect_class_known;
    const classification = classifyCancellation({ effect_class: declaredClass, effect_class_known: declaredKnown });

    /** @type {Partial<CancelRequest>} */
    const request = {
      request_id: requestId,
      task_id: taskId,
      requested_by: requestedBy,
      reason,
      reason_code: reasonCode,
      requested_at: startedAt,
      effect_class: classification.effect_class,
      class_known: classification.class_known,
      action: classification.action,
      deadline_ms: effectiveDeadline,
    };

    write('task.cancel.requested', { ...request, recorded_at: startedAt }, requestId);
    write('task.cancel.admitted_closed', { request_id: requestId, task_id: taskId }, requestId);
    write(
      'task.cancel.acknowledged',
      { request_id: requestId, task_id: taskId, in_flight: task.effect_class ? [task.effect_class] : [], action: classification.action },
      requestId,
    );

    // The terminal intent row: written while everything is still alive, before a
    // single process is signalled, so the log can prove the intent existed even
    // if this process dies on the next line.
    taskStore.transition(taskId, 'cancelling', { reason: `cancel requested by ${requestedBy}: ${reasonCode}` });

    // A task that was never admitted has no effect in flight, so there is nothing
    // to kill and nothing for a human to decide — escalating would ask about an
    // effect that never existed. The class is still recorded, just not
    // actionable, and the settle says `never_started` rather than a bare zero
    // that reads like a successful kill.
    const neverStarted = state === 'submitted';

    // The job, resolved exactly once. Asking twice would let a port that stopped
    // answering look like a task that never had a job, and "no job" is one of the
    // two ways to reach a verified zero.
    /** @type {JobControl|null} */
    let control = null;
    /** @type {string|null} */
    let controlError = null;
    if (typeof jobControl === 'function') {
      try {
        control = jobControl(taskId) ?? null;
      } catch (err) {
        controlError = messageOf(err);
      }
    }

    let killAttempted = false;
    let stopRequested = false;
    let deadlineExceeded = false;
    /** @type {WritesRecord|null} */
    let writes = null;
    /** @type {QuarantineRecord|null} */
    let quarantined = null;
    // Nothing is in flight only when the task never left `submitted` and there is
    // no handle to enumerate. A handle that exists outranks the inference, so
    // such a task is acted on like any other.
    const nothingInFlight = neverStarted && !control && controlError === null;
    let escalated = classification.action === 'escalate_no_kill' && !nothingInFlight;
    let escalationDetail = classification.escalation_detail;

    /**
     * Enumerate live processes in the job, and record how the answer was
     * obtained. `null` means "not known" — not the same answer as zero, and never
     * allowed to become one.
     * @returns {Promise<{survivors: number[]|null, verified_by: string}>}
     */
    const verifySurvivors = async () => {
      // The strongest fact available: the task never left `submitted` and owns no
      // handle, so no effect began and no job could have been registered.
      if (nothingInFlight) return { survivors: [], verified_by: 'never_started' };
      if (controlError !== null) return { survivors: null, verified_by: 'job_lookup_failed' };
      if (!control) {
        // `indeterminate` means the runner lost the handle. A missing handle is
        // not evidence that nothing is running — it is often the very reason the
        // state is unknown — so it must not become a verified zero.
        if (state === 'indeterminate') return { survivors: null, verified_by: 'job_handle_missing' };
        return { survivors: [], verified_by: 'no_job_registered' };
      }
      try {
        const pids = await control.enumerate();
        if (!Array.isArray(pids)) return { survivors: null, verified_by: 'enumeration_not_an_array' };
        const clean = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))];
        return { survivors: clean, verified_by: 'os_enumeration' };
      } catch {
        return { survivors: null, verified_by: 'enumeration_failed' };
      }
    };

    /** @type {{survivors: number[]|null, verified_by: string}} */
    let verification = { survivors: null, verified_by: 'not_reached' };

    /**
     * The action phase, bounded by the deadline. Anything that does not finish in
     * time escalates instead of being reported as a stop that happened.
     * @returns {Promise<void>}
     */
    const act = async () => {
      if (nothingInFlight) {
        write(
          'task.cancel.before_effect',
          { request_id: requestId, task_id: taskId, detail: 'the task was cancelled before admission, so no effect had begun' },
          requestId,
        );
        return;
      }

      if (escalated) {
        write(
          'task.cancel.escalated',
          {
            request_id: requestId,
            task_id: taskId,
            reason_code: 'HUMAN_REQUIRED',
            effect_class: classification.effect_class,
            class_known: classification.class_known,
            detail: escalationDetail,
            killed: false,
          },
          requestId,
        );
        return;
      }

      if (classification.action === 'stop_at_safe_point') {
        // read_only: nothing to reconcile, so the stop is asked for at the next
        // safe point rather than forced. No terminate call is made.
        if (control && typeof control.requestStop === 'function') {
          await control.requestStop();
          stopRequested = true;
          write('task.cancel.safe_point.requested', { request_id: requestId, task_id: taskId }, requestId);
        }
        return;
      }

      if (!control) {
        // The task owns no job, so there is nothing to kill. Verification below
        // still runs and still decides the outcome.
        write('task.cancel.killed', { request_id: requestId, task_id: taskId, killed: false, detail: 'no job registered for this task' }, requestId);
        return;
      }

      killAttempted = true;
      await control.terminate();
      write('task.cancel.killed', { request_id: requestId, task_id: taskId, killed: true, action: classification.action }, requestId);

      const dir = workspaceDir(taskId);
      if (classification.action === 'kill_then_record_writes' || classification.action === 'kill_then_mark_unusable') {
        if (!dir || !existsSync(dir)) {
          writes = { recorded: false, detail: dir ? `no workspace directory at ${dir}` : 'no workspace is known for this task', files: [] };
        } else {
          try {
            writes = { recorded: true, detail: `listed ${dir}`, files: listFiles(dir) };
            write('task.cancel.writes_recorded', { request_id: requestId, task_id: taskId, files: writes.files.length }, requestId);
          } catch (err) {
            writes = { recorded: false, detail: `the workspace could not be listed: ${messageOf(err)}`, files: [] };
          }
        }
        if (classification.action === 'kill_then_mark_unusable' && writes.recorded && writes.files.length > 0) {
          quarantined = markUnusable(/** @type {string} */ (dir), writes.files, requestId);
          write(
            'task.cancel.writes_marked_unusable',
            { request_id: requestId, task_id: taskId, renamed: quarantined.renamed.length, failed: quarantined.failed.length },
            requestId,
          );
        }
      }
    };

    try {
      await withDeadline(act(), effectiveDeadline);
    } catch (err) {
      if (err instanceof CancelError && err.code === 'CANCEL_DEADLINE_EXCEEDED') {
        deadlineExceeded = true;
        escalated = true;
        write(
          'task.cancel.escalated',
          { request_id: requestId, task_id: taskId, reason_code: 'DEADLINE_EXCEEDED', deadline_ms: effectiveDeadline, detail: messageOf(err) },
          requestId,
        );
      } else {
        // A kill path that threw is not a cancellation. Record it, then settle
        // from the evidence that exists rather than from the intent that did not
        // complete.
        write(
          'task.cancel.failed',
          { request_id: requestId, task_id: taskId, reason_code: 'ACTION_FAILED', detail: messageOf(err) },
          requestId,
        );
        escalated = false;
      }
    }

    verification = await verifySurvivors();
    // The closure above assigns these, and the checker cannot follow a closure's
    // narrowing, so the declared union is restated here. The values are real;
    // only the narrowing is not.
    const finalWrites = /** @type {WritesRecord|null} */ (writes);
    const finalQuarantined = /** @type {QuarantineRecord|null} */ (quarantined);
    const zeroSurvivors = Array.isArray(verification.survivors) && verification.survivors.length === 0;
    const survivors = verification.survivors ? verification.survivors.length : null;

    // An `indeterminate` task whose job could not be read is the one case the
    // cascade hands to a human even though the class said "kill": it cannot prove
    // zero survivors, and it cannot signal a tree it has no handle for. Settling
    // quietly as `cancel_failed` would leave a possibly-live process with nobody
    // told about it.
    if (!zeroSurvivors && !escalated && state === 'indeterminate') {
      escalated = true;
      escalationDetail =
        'the task was indeterminate and its job could not be enumerated, so zero survivors could not be verified';
      write(
        'task.cancel.escalated',
        {
          request_id: requestId,
          task_id: taskId,
          reason_code: 'SURVIVORS_UNVERIFIABLE',
          effect_class: classification.effect_class,
          survivors_verified_by: verification.verified_by,
          killed: killAttempted,
          detail: escalationDetail,
        },
        requestId,
      );
    }

    // Settle. `cancelled` is refused unless the enumeration was actually read and
    // was empty; every other outcome is `cancel_failed`, which is a terminal
    // state and not a flavour of success.
    const settleCancelled = zeroSurvivors && !escalated && !deadlineExceeded;
    const to = settleCancelled ? 'cancelled' : 'cancel_failed';
    const reasonForSettle = settleCancelled
      ? `zero survivors verified by ${verification.verified_by}`
      : escalated
        ? `escalated: ${deadlineExceeded ? 'the cancellation deadline passed' : escalationDetail}`
        : `survivors remained: ${survivors === null ? 'the count could not be read' : survivors}`;

    taskStore.transition(taskId, to, {
      reason: reasonForSettle,
      evidence: /** @type {{requiredChecksPassed?: boolean, survivingProcesses?: number|null}} */ (
        /** @type {unknown} */ ({
          survivingProcesses: survivors,
          survivors: verification.survivors,
          survivors_verified_by: verification.verified_by,
          action: classification.action,
          effect_class: classification.effect_class,
          cancelled_before_effect: neverStarted,
          escalated,
          deadline_exceeded: deadlineExceeded,
          kill_attempted: killAttempted,
        })
      ),
    });
    write(
      settleCancelled ? 'task.cancelled' : 'task.cancel.failed',
      {
        request_id: requestId,
        task_id: taskId,
        action: classification.action,
        effect_class: classification.effect_class,
        survivors,
        survivors_verified_by: verification.verified_by,
        escalated,
        deadline_exceeded: deadlineExceeded,
      },
      requestId,
    );

    const humanAction = escalated
      ? deadlineExceeded
        ? 'the cancellation deadline passed with work still in flight; the human decides whether to force it'
        : escalationDetail
      : null;

    /** @type {import('../core/types.mjs').TaskResult} */
    const result = {
      claims: [],
      artifacts: [],
      evidence: [
        {
          kind: 'cancel',
          request_id: requestId,
          requested_by: requestedBy,
          reason_code: reasonCode,
          action: classification.action,
          effect_class: classification.effect_class,
          class_known: classification.class_known,
          kill_attempted: killAttempted,
          stop_requested: stopRequested,
          cancelled_before_effect: neverStarted,
          escalated,
          deadline_exceeded: deadlineExceeded,
          deadline_ms: effectiveDeadline,
        },
        { kind: 'survivors', count: survivors, pids: verification.survivors, verified_by: verification.verified_by },
        ...(finalWrites ? [{ kind: 'writes', recorded: finalWrites.recorded, detail: finalWrites.detail, files: finalWrites.files }] : []),
        ...(finalQuarantined
          ? [{ kind: 'quarantine', scope: finalQuarantined.scope, renamed: finalQuarantined.renamed, failed: finalQuarantined.failed }]
          : []),
      ],
      checks: [],
      not_verified: finalWrites && !finalWrites.recorded ? [{ id: 'writes', detail: finalWrites.detail }] : [],
      indeterminate: [
        ...(escalated && classification.effect_class === 'external'
          ? [{ what: 'external attempt', why: 'the attempt was never killed mid-flight, so its outcome is unknown until the adapter reports' }]
          : []),
        ...(escalated && state === 'indeterminate' && !zeroSurvivors
          ? [{ what: 'surviving processes', why: 'the task was indeterminate and its job could not be enumerated, so a live process may remain' }]
          : []),
        ...(finalQuarantined
          ? finalQuarantined.renamed.map((r) => ({ what: r.to, why: `partial write marked unusable; the commit to ${r.from} did not complete` }))
          : []),
      ],
      decision_ids: [],
      tool: { tool_id: 'cancellation', status: to, reason_code: escalated ? (deadlineExceeded ? 'DEADLINE_EXCEEDED' : 'HUMAN_REQUIRED') : null },
    };
    let resultRecorded = false;
    try {
      taskStore.setResult(taskId, result);
      resultRecorded = true;
    } catch (err) {
      write('task.cancel.result_failed', { request_id: requestId, task_id: taskId, detail: messageOf(err) }, requestId);
    }

    if (escalated && typeof escalate === 'function') {
      try {
        escalate(baseRequest({ ...request, status: 'escalated', state: to, escalated: true, human_action_required: humanAction }));
      } catch (err) {
        write('task.cancel.escalation_notification_failed', { request_id: requestId, detail: messageOf(err) }, requestId);
      }
    }

    return baseRequest({
      ...request,
      status: escalated ? 'escalated' : to,
      state: to,
      survivors,
      survivor_pids: verification.survivors,
      survivors_verified_by: verification.verified_by,
      kill_attempted: killAttempted,
      stop_requested: stopRequested,
      escalated,
      deadline_exceeded: deadlineExceeded,
      human_action_required: humanAction,
      writes: finalWrites,
      quarantined: finalQuarantined,
      events,
      result_recorded: resultRecorded,
    });
  }

  return {
    /**
     * Request cancellation of a task, idempotently.
     *
     * @param {string} taskId
     * @param {{reason?: string, reason_code?: string, requested_by?: string, effect_class?: string, effect_class_known?: boolean, deadline_ms?: number}} [options]
     * @returns {Promise<CancelRequest>}
     */
    requestCancellation(taskId, options = {}) {
      // A concurrent second call joins the first rather than starting a second
      // sequence. This is the in-process half of idempotency; the durable half is
      // the `task.cancel.requested` row, which answers a call made after a
      // restart.
      const running = inFlight.get(taskId);
      if (running) return running;
      const started = perform(taskId, options);
      inFlight.set(taskId, started);
      return started.finally(() => {
        inFlight.delete(taskId);
      });
    },
    /**
     * The cancellation already running for this task, or null. A caller that has
     * just noticed the task is no longer where it left it wants to wait for the
     * cascade rather than race it, and this is the handle to wait on.
     *
     * @param {string} taskId
     * @returns {Promise<CancelRequest>|null}
     */
    settled(taskId) {
      return inFlight.get(taskId) ?? null;
    },
    pending() {
      return inFlight.size;
    },
  };
}
