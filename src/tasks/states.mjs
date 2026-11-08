// Task state transitions.
//
// Two rules, both of them things this project has already been burned by:
//
//   - No transition into a terminal state is inferred. `completed` needs every
//     required check to have passed, `cancelled` needs zero surviving
//     processes. A state change nobody verified is a claim, and the log exists
//     so that claims are not the record.
//   - Terminal is terminal. There is no edge out of completed, failed,
//     cancelled or cancel_failed. Picking work back up is a new task.
import { TASK_STATES } from './contract.mjs';

// From a state, which states may follow.
//
// Note where `cancelling` is reachable from. Every non-terminal state, not just
// `running`, because a task nobody can stop is not safe to start. `submitted`
// means no effect has begun, so the honest record is "stopped before anything
// happened"; `indeterminate` means the runner lost track, so the request has to
// be recordable even though what it can conclude is limited. The conditions for
// those two are in transitionRequirements below, not in this table.
/** @type {Record<string, string[]>} */
export const TRANSITIONS = Object.freeze({
  submitted: ['admitted', 'failed', 'cancelling'],
  admitted: ['running', 'cancelling', 'failed'],
  running: ['completed', 'failed', 'cancelling', 'indeterminate'],
  cancelling: ['cancelled', 'cancel_failed'],
  indeterminate: ['running', 'failed', 'cancelled', 'cancelling'],
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
 * What a target state demands beyond being reachable. A non-empty list means
 * the caller has to satisfy all of it before writing the transition.
 *
 * @param {string} to
 * @param {{requiredChecksPassed?: boolean, survivingProcesses?: number|null,
 *   reason?: string|null, evidenceCount?: number}} evidence
 * @returns {string[]}
 */
export function transitionRequirements(to, evidence = {}) {
  const missing = [];

  if (to === 'completed' && evidence.requiredChecksPassed !== true) {
    missing.push('required_checks_passed');
  }

  // Evidence, not a flag. The check above is the caller's word about its own
  // work; one recorded evidence entry is the half it cannot talk its way past.
  // A task claiming success with an empty evidence list is the exact failure
  // this milestone exists to make impossible.
  if (to === 'completed' && (evidence.evidenceCount ?? 0) < 1) {
    missing.push('recorded_evidence');
  }

  if (to === 'cancelled' && evidence.survivingProcesses !== 0) {
    missing.push('zero_surviving_processes');
  }

  if (to === 'failed' && !evidence.reason) {
    missing.push('failure_reason');
  }

  return missing;
}
