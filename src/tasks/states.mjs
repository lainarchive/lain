/**
 * Task state transitions.
 *
 * Two things this module refuses to allow, both of which are properties the
 * project has already paid for once:
 *
 *   1. **No transition into a terminal state is inferred.** Reaching `completed`
 *      requires every required check to have passed; reaching `cancelled`
 *      requires zero surviving processes. A state change nobody verified is a
 *      claim, and the event store exists so that claims are not the record.
 *   2. **Terminal is terminal.** There is no edge out of `completed`, `failed`,
 *      `cancelled` or `cancel_failed`. Continuing work after a terminal state is
 *      a new task, not a resume of this one.
 */
import { TASK_STATES } from './contract.mjs';

/**
 * Legal transitions. Read as: from a state, which states may follow.
 * @type {Record<string, string[]>}
 */
export const TRANSITIONS = Object.freeze({
  submitted: ['admitted', 'failed'],
  admitted: ['running', 'cancelling', 'failed'],
  running: ['completed', 'failed', 'cancelling', 'indeterminate'],
  cancelling: ['cancelled', 'cancel_failed'],
  indeterminate: ['running', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
  cancel_failed: [],
});

/** @param {string} state */
export function isTerminal(state) {
  return Array.isArray(TRANSITIONS[state]) && TRANSITIONS[state].length === 0;
}

/** @param {string} state */
export function isKnownState(state) {
  return TASK_STATES.includes(state);
}

/**
 * @param {string} from
 * @param {string} to
 * @returns {{legal: boolean, code: string}}
 */
export function checkTransition(from, to) {
  if (!isKnownState(from)) return { legal: false, code: 'UNKNOWN_SOURCE_STATE' };
  if (!isKnownState(to)) return { legal: false, code: 'UNKNOWN_TARGET_STATE' };
  if (isTerminal(from)) return { legal: false, code: 'TERMINAL_IS_TERMINAL' };
  const allowed = TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) return { legal: false, code: 'ILLEGAL_TRANSITION' };
  return { legal: true, code: 'OK' };
}

/**
 * The extra conditions a target state demands. Returning a list means the caller
 * must satisfy all of them *before* writing the transition; an empty list means
 * the transition needs nothing further.
 *
 * @param {string} to
 * @param {{requiredChecksPassed?: boolean, survivingProcesses?: number|null, reason?: string|null, evidenceCount?: number}} evidence
 * @returns {string[]}
 */
export function transitionRequirements(to, evidence = {}) {
  const missing = [];
  if (to === 'completed' && evidence.requiredChecksPassed !== true) missing.push('required_checks_passed');
  // Evidence, not a flag. `required_checks_passed` is the caller's claim about
  // its own checks; requiring at least one recorded evidence entry is the
  // structural half of the same rule, and it is the half a caller cannot talk
  // its way past. A task that claims success with an empty evidence list is
  // exactly the failure this milestone exists to make impossible.
  if (to === 'completed' && (evidence.evidenceCount ?? 0) < 1) missing.push('recorded_evidence');
  if (to === 'cancelled') {
    if (evidence.survivingProcesses !== 0) missing.push('zero_surviving_processes');
  }
  if (to === 'failed' && !evidence.reason) missing.push('failure_reason');
  return missing;
}
