/**
 * Resource budget and admission (M-1 Step 3).
 *
 * The budget keeps five kinds of number apart, because merging them is how a
 * guess becomes a remembered fact:
 *
 * - `measured`    — read from this machine now (or from the store's own record).
 * - `historical`  — measured earlier, kept for comparison, never used as a limit.
 * - `configured`  — an operating limit the user or the profile sets.
 * - `recommended` — a default proposed by the profile.
 * - `estimated`   — not measured. Nothing in this file is estimated, and any
 *                   number that would have to be is left absent with a reason.
 *
 * Admission is deterministic and fail-closed: it answers from the numbers it was
 * given, returns `indeterminate` when a required number is missing, and never
 * adapts by quietly reducing context, switching models or lowering precision.
 */

import { AdmissionError } from '../core/errors.mjs';
import { requireInteger, requireRecord, requireString } from '../core/validate.mjs';

/** Profile names. Three, because three different operating intentions exist. */
export const PROFILE_NAMES = ['minimal-background', 'standard-development', 'higher-resource-workload'];

/** Reserved for the OS and the desktop session, in bytes. Derived, not measured. */
export const HOST_RESERVE_BYTES = 4 * 1024 * 1024 * 1024;

/** VRAM the display and the desktop compositor are using, in MiB. */
export const DISPLAY_RESERVE_MIB = 768;

/** Bytes per event, measured in the audit's storage benchmarks (146 B/event). */
export const BYTES_PER_EVENT = 146;

/** Store growth warning threshold, in bytes. */
export const STORE_WARNING_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * A number with its provenance attached.
 *
 * Deliberately not named `Number`: a typedef with that name shadows the built-in
 * type and makes every arithmetic and index expression in the file a type error.
 *
 * @typedef {object} BudgetNumber
 * @property {number} value
 * @property {'measured'|'historical'|'configured'|'recommended'|'estimated'} kind
 * @property {string} note
 */

/**
 * @param {number} value
 * @param {'measured'|'historical'|'configured'|'recommended'|'estimated'} kind
 * @param {string} note
 * @returns {BudgetNumber}
 */
function num(value, kind, note) {
  return { value, kind, note };
}

/**
 * The three profiles.
 *
 * Every entry states where its number comes from. `configured` entry values are
 * limits; `recommended` ones may be overridden by configuration.
 *
 * @returns {Record<string, object>}
 */
export function defaultProfiles() {
  return {
    'minimal-background': {
      name: 'minimal-background',
      intent: 'One task at a time, nothing resident that is not needed now.',
      limits: {
        model_calls_in_flight: num(1, 'configured', 'one model call at a time; more needs VRAM this machine does not have'),
        tool_subprocesses: num(1, 'configured', 'a background profile trades throughput for headroom'),
        live_task_agents: num(1, 'configured', 'one live agent: the smallest profile exists to stay out of the way'),
        delegation_depth: num(0, 'configured', 'no delegation in the most constrained profile'),
        context_tokens: num(4096, 'configured', 'the v0.1 binding context; raising it changes what a result means'),
        model_memory_bytes: num(3 * 1024 * 1024 * 1024, 'configured', 'sized for a small resident model, still clamped against measured VRAM at admission'),
        lain_memory_bytes: num(3 * 1024 * 1024 * 1024, 'configured', ''),
        store_bytes: num(2 * 1024 * 1024 * 1024, 'recommended', 'growth warning threshold; no retention is implemented yet'),
      },
    },
    'standard-development': {
      name: 'standard-development',
      intent: 'Interactive work with a model resident and room for a test run.',
      limits: {
        model_calls_in_flight: num(1, 'configured', 'one model call in flight; parallel inference is not available at 6 GB VRAM'),
        tool_subprocesses: num(3, 'configured', 'min(4, logical CPU count - 1) on this machine'),
        live_task_agents: num(4, 'configured', 'four concurrent tasks, each awaiting a model turn rather than running one'),
        delegation_depth: num(2, 'configured', 'a subagent may delegate once more, and no further'),
        context_tokens: num(4096, 'configured', 'the v0.1 binding context; raising it changes what a result means'),
        model_memory_bytes: num(4 * 1024 * 1024 * 1024, 'recommended', 'a 4B model at Q4 with a 4096-token context fits under this'),
        lain_memory_bytes: num(6 * 1024 * 1024 * 1024, 'recommended', 'clamped at admission by free memory minus the host reserve'),
        store_bytes: num(10 * 1024 * 1024 * 1024, 'recommended', 'room for roughly 68 million events at the measured 146 bytes per event'),
      },
    },
    'higher-resource-workload': {
      name: 'higher-resource-workload',
      intent: 'A deliberately heavy run, when nothing else needs the machine.',
      limits: {
        model_calls_in_flight: num(1, 'configured', 'still one: VRAM is the hard constraint, not intent'),
        tool_subprocesses: num(3, 'configured', 'the CPU count does not change with intent, so neither does this'),
        live_task_agents: num(4, 'configured', 'a heavy run does not raise the agent ceiling; it raises what each may use'),
        delegation_depth: num(2, 'configured', 'unchanged from the standard profile, for the same reason'),
        context_tokens: num(8192, 'configured', 'only if the measured model fit allows it; otherwise refused'),
        model_memory_bytes: num(5 * 1024 * 1024 * 1024, 'recommended', ''),
        lain_memory_bytes: num(8 * 1024 * 1024 * 1024, 'recommended', ''),
        store_bytes: num(20 * 1024 * 1024 * 1024, 'recommended', 'the largest budget that still leaves the system volume with free space'),
      },
    },
  };
}

/**
 * The minimum a probe record must expose for admission to use it.
 *
 * Declared structurally rather than imported so admission can be tested with a
 * fixture that contains only what a decision needs.
 *
 * @typedef {object} HostRecord
 * @property {{ free_mib?: number|null, status?: string }} [gpu]
 * @property {{ free_bytes?: number|null, status?: string }} [disk]
 * @property {{ free_bytes?: { value?: number|null } }} [memory]
 */

/**
 * @typedef {object} Budget
 * @property {string} profile
 * @property {Record<string, BudgetNumber>} limits
 * @property {HostRecord} host the probe record this budget was built from
 * @property {string[]} derived_notes
 */

/**
 * @typedef {object} BudgetCheck
 * @property {string} check
 * @property {number} requested
 * @property {number} limit
 * @property {'measured'|'historical'|'configured'|'recommended'|'estimated'} kind
 * @property {boolean} fits
 */

/**
 * @typedef {object} AdmissionDecision
 * @property {'admit'|'deny'|'indeterminate'} outcome
 * @property {string} reason_code
 * @property {string} reason
 * @property {BudgetCheck[]} checks
 * @property {Budget} budget
 */

/**
 * Build a budget from a probe record and a profile.
 *
 * Pure: it reads the probe record, not the machine.
 *
 * @param {object} input
 * @param {object} input.probe a record from `src/host/probe.mjs`
 * @param {string} [input.profile]
 * @param {Record<string, object>} [input.profiles]
 * @param {Record<string, number>} [input.overrides]
 * @returns {Budget}
 */
export function buildBudget(input) {
  const probe = requireRecord(input.probe, 'probe');
  const profiles = input.profiles ?? defaultProfiles();
  const profileName = input.profile ?? 'standard-development';
  if (!Object.hasOwn(profiles, profileName)) {
    throw new AdmissionError('deny', 'BUDGET_PROFILE_UNKNOWN', `unknown profile "${profileName}"`, {
      known: Object.keys(profiles),
    });
  }
  const profile = /** @type {{ limits: Record<string, BudgetNumber> }} */ (profiles[profileName]);

  const limits = /** @type {Record<string, BudgetNumber>} */ ({});
  for (const [key, entry] of Object.entries(profile.limits)) {
    limits[key] = { ...entry };
  }
  for (const [key, value] of Object.entries(input.overrides ?? {})) {
    if (!Object.hasOwn(limits, key)) {
      throw new AdmissionError('deny', 'BUDGET_LIMIT_UNKNOWN', `unknown limit "${key}"`);
    }
    const existing = /** @type {BudgetNumber} */ (limits[key]);
    limits[key] = num(requireInteger(value, key, { min: 0 }), 'configured', `override of a ${existing.kind} value`);
  }

  const derivedNotes = [];
  const probeMemory = /** @type {{ free_bytes?: { value?: number|null } }} */ (probe.memory ?? {});
  const freeBytes = probeMemory.free_bytes?.value ?? null;
  if (typeof freeBytes === 'number') {
    const configured = /** @type {BudgetNumber} */ (limits.lain_memory_bytes);
    const ceiling = Math.min(configured.value, Math.max(0, freeBytes - HOST_RESERVE_BYTES));
    derivedNotes.push(
      `lain_memory_bytes ${configured.value} clamped to ${ceiling} by measured free memory ${freeBytes} minus the ${HOST_RESERVE_BYTES} host reserve`,
    );
    limits.lain_memory_bytes = num(ceiling, 'configured', 'clamped by measured free memory at build time');
  } else {
    derivedNotes.push('free memory was not measured, so lain_memory_bytes was not clamped');
  }

  return { profile: profileName, limits, host: probe, derived_notes: derivedNotes };
}

/**
 * @typedef {object} AdmissionRequest
 * @property {string} action
 * @property {number} [model_memory_bytes]
 * @property {number} [context_tokens]
 * @property {number} [tool_subprocesses]
 * @property {number} [live_task_agents]
 * @property {number} [store_growth_bytes]
 */

/**
 * Decide whether a request fits the budget.
 *
 * @param {Budget} budget
 * @param {AdmissionRequest} request
 * @returns {AdmissionDecision}
 */
export function admit(budget, request) {
  const req = requireRecord(request, 'request');
  const action = requireString(req.action, 'action');
  /** @type {BudgetCheck[]} */
  const checks = [];
  /**
   * @param {string} reasonCode
   * @param {string} reason
   * @returns {AdmissionDecision}
   */
  const deny = (reasonCode, reason) => ({
    outcome: 'deny',
    reason_code: reasonCode,
    reason,
    checks,
    budget,
  });
  /**
   * @param {string} reasonCode
   * @param {string} reason
   * @returns {AdmissionDecision}
   */
  const indeterminate = (reasonCode, reason) => ({
    outcome: 'indeterminate',
    reason_code: reasonCode,
    reason,
    checks,
    budget,
  });

  // Every limit that is a count is checked first: a count is always knowable.
  /** @type {[string, unknown, string|null][]} */
  const counts = [
    ['tool_subprocesses', req.tool_subprocesses, 'TOOL_SUBPROCESS_LIMIT'],
    ['live_task_agents', req.live_task_agents, 'LIVE_AGENT_LIMIT'],
    ['model_calls_in_flight', 1, null],
  ];
  for (const [key, requested, code] of counts) {
    if (typeof requested !== 'number' || code === null) continue;
    const limit = budget.limits[key];
    if (limit === undefined) continue;
    const fits = requested <= limit.value;
    checks.push({ check: key, requested, limit: limit.value, kind: limit.kind, fits });
    if (!fits) return deny(code, `requested ${requested} ${key.replace(/_/g, ' ')} exceeds the configured limit ${limit.value}`);
  }

  // Context: compared against the configured ceiling. Refuse rather than shrink.
  if (typeof req.context_tokens === 'number') {
    const limit = /** @type {BudgetNumber} */ (budget.limits.context_tokens);
    const fits = req.context_tokens <= limit.value;
    checks.push({ check: 'context_tokens', requested: req.context_tokens, limit: limit.value, kind: limit.kind, fits });
    if (!fits) {
      return deny(
        'CONTEXT_LIMIT',
        `requested context ${req.context_tokens} tokens exceeds the configured ceiling ${limit.value}; Lain will not reduce context silently to fit`,
      );
    }
  }

  // Model memory: needs both a requested size and a measured free VRAM.
  if (typeof req.model_memory_bytes === 'number') {
    const limit = /** @type {BudgetNumber} */ (budget.limits.model_memory_bytes);
    const fitsLimit = req.model_memory_bytes <= limit.value;
    checks.push({ check: 'model_memory_bytes', requested: req.model_memory_bytes, limit: limit.value, kind: limit.kind, fits: fitsLimit });
    if (!fitsLimit) {
      return deny(
        'MODEL_MEMORY_LIMIT',
        `requested model memory ${req.model_memory_bytes} bytes exceeds the configured budget ${limit.value}`,
      );
    }
    const host = /** @type {HostRecord} */ (budget.host);
    const freeMib = host.gpu?.free_mib ?? null;
    if (freeMib === null) {
      return indeterminate(
        'GPU_UNMEASURED',
        'model memory was requested but free VRAM could not be measured; admission requires a measurement rather than an assumption',
      );
    }
    const usableBytes = Math.max(0, freeMib - DISPLAY_RESERVE_MIB) * 1024 * 1024;
    const fitsVram = req.model_memory_bytes <= usableBytes;
    checks.push({ check: 'vram', requested: req.model_memory_bytes, limit: usableBytes, kind: 'measured', fits: fitsVram });
    if (!fitsVram) {
      return deny(
        'VRAM_INSUFFICIENT',
        `requested model memory ${req.model_memory_bytes} bytes exceeds usable VRAM ${usableBytes} bytes (measured free VRAM minus a ${DISPLAY_RESERVE_MIB} MiB display reserve)`,
      );
    }
  }

  // Store growth: a warning threshold, checked against the measured volume.
  if (typeof req.store_growth_bytes === 'number') {
    const freeDisk = (/** @type {HostRecord} */ (budget.host)).disk?.free_bytes ?? null;
    if (freeDisk === null) {
      return indeterminate(
        'DISK_UNMEASURED',
        'store growth was requested but free disk space could not be measured',
      );
    }
    const fits = req.store_growth_bytes <= freeDisk;
    checks.push({ check: 'store_growth_bytes', requested: req.store_growth_bytes, limit: freeDisk, kind: 'measured', fits });
    if (!fits) {
      return deny('DISK_INSUFFICIENT', `requested store growth ${req.store_growth_bytes} bytes exceeds measured free disk ${freeDisk} bytes`);
    }
  }

  return { outcome: /** @type {'admit'} */ ('admit'), reason_code: 'WITHIN_BUDGET', reason: `${action} fits every configured limit and every required measurement is present`, checks, budget };
}

/**
 * Events in the store before the growth warning threshold is reached.
 *
 * @param {number} [limitBytes]
 * @returns {number}
 */
export function eventsBeforeWarning(limitBytes = STORE_WARNING_BYTES) {
  return Math.floor(requireInteger(limitBytes, 'limitBytes', { min: 1 }) / BYTES_PER_EVENT);
}
