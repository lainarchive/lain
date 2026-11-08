/**
 * `decide()` — the Policy Engine.
 *
 * Three properties matter more than anything else in this file:
 *
 *   1. **Total.** Every request produces a decision. It never throws, never
 *      returns undefined, and never leaves the caller to guess what happened. A
 *      predicate that throws is caught and becomes a recorded refusal.
 *   2. **Default deny.** The last arm exists so that a request nothing
 *      recognised is refused, never allowed.
 *   3. **Recorded before the action.** `decide()` returns a decision carrying an
 *      id, a rule id and a reason code; the executor requires that id before it
 *      will run anything. Authorisation therefore happens outside any model and
 *      before any effect.
 *
 * The decision is *not* where enforcement lives. `allow_with_conditions` carries
 * a condition string, and the executor is what enforces it. A policy that only
 * described intent without an executor that checked it would be a comment.
 */
import { requireString } from '../core/validate.mjs';
import { ulid } from '../core/ids.mjs';
import { ARMS, armById, isRefusal, normaliseEffectClass } from './arms.mjs';

/** @typedef {import('./arms.mjs').Outcome} Outcome */

/**
 * @typedef {object} PolicyRequest
 * @property {string} action               stable verb, e.g. "tool.invoke"
 * @property {string} [target]             what the action is applied to
 * @property {string} [tool_id]
 * @property {string} effect_class
 * @property {string[]} [requested_capabilities]
 * @property {string} [task_id]
 * @property {string} [session_id]
 * @property {object} [resource_request]
 * @property {string} [requested_by]
 * @property {string} [prompt_context_digest]
 */

/**
 * Everything the decision depends on. All of it is supplied by the caller, and
 * all of it is optional: absent context is a *refusal*, never a permission.
 *
 * @typedef {object} PolicyContext
 * @property {boolean} [granted]           does the task hold the capability?
 * @property {boolean} [forbidden]         does an explicit rule forbid it?
 * @property {{exceeded: boolean, detail?: string}} [budget]
 * @property {boolean} [complete]          is the evaluation context complete?
 * @property {{status: 'pending'|'granted'|'denied'|'timed_out'|null, approval_id?: string}} [approval]
 */

/**
 * @typedef {object} Decision
 * @property {string} decision_id
 * @property {Outcome} outcome
 * @property {string} arm_id
 * @property {string} reason_code
 * @property {string} reason
 * @property {string|null} error  present when an arm's predicate threw
 * @property {string[]} conditions
 * @property {string|null} approval_id
 * @property {string} effect_class
 * @property {string} action
 * @property {string|null} target
 * @property {string} decided_at
 * @property {string} decided_by
 * @property {boolean} retryable
 */

const DECIDED_BY = 'policy@0.1.0';

/** Human-readable text per reason code. Kept beside the arms' codes. */
/** @type {Record<string, string>} */
const REASONS = Object.freeze({
  EXPLICIT_DENIAL: 'the user denied this request',
  APPROVAL_TIMED_OUT: 'the approval window closed with no answer; absence of approval is denial',
  POLICY_RULE_FORBIDS: 'an explicit policy rule forbids this action',
  BUDGET_EXCEEDED: 'the request exceeds the task budget',
  EFFECT_CLASS_REQUIRES_APPROVAL: 'this effect class requires explicit approval',
  POLICY_EVALUATION_INCOMPLETE: 'the policy context is incomplete, so the request cannot be decided',
  READ_ONLY_WITHIN_GRANT: 'read-only action within the granted capability set',
  REVERSIBLE_WITHIN_WORKSPACE: 'reversible action within the granted capability set',
  EVALUATION_ERROR: 'policy evaluation failed; refusing by default',
});

/**
 * Decide one request. Total by construction.
 *
 * @param {PolicyRequest} request
 * @param {PolicyContext} [context]
 * @param {{now?: () => number, newId?: () => string}} [options]
 * @returns {Decision}
 */
export function decide(request, context = {}, options = {}) {
  const now = options.now ?? Date.now;
  const newId = options.newId ?? (() => ulid(now()));

  const action = typeof request?.action === 'string' && request.action.length > 0 ? request.action : 'unknown';
  const effectClass = normaliseEffectClass(request?.effect_class);
  const target = typeof request?.target === 'string' ? request.target : null;

  /** @type {{arm_id: string, outcome: Outcome, reason_code: string, condition?: string, error?: string}} */
  let chosen = { arm_id: 'A9', outcome: 'defer_policy_error', reason_code: 'EVALUATION_ERROR' };

  // Evaluation order is A1, A2, A3 (a rule outranks an approval prompt, so a
  // forbidden action never reaches a human), then the approval requirement, then
  // budget, completeness, and finally the permissive arms. The default arm is
  // last and is the only one that cannot fail to match.
  const order = ['A1', 'A2', 'A3', 'A5', 'A4', 'A6', 'A6b', 'A7', 'A8'];
  try {
    for (const id of order) {
      const arm = armById(id);
      if (!arm) continue;
      if (arm.when(request, context)) {
        chosen = { arm_id: arm.id, outcome: arm.outcome, reason_code: arm.reason_code, condition: arm.condition };
        break;
      }
    }
  } catch (err) {
    // A predicate threw. Refuse, and say why — never allow because the check
    // could not be completed.
    chosen = {
      arm_id: 'A9',
      outcome: 'defer_policy_error',
      reason_code: 'EVALUATION_ERROR',
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const conditions = chosen.condition ? [chosen.condition] : [];
  const reason = REASONS[chosen.reason_code] ?? chosen.reason_code;

  // Reading the approval id must not be able to throw either: `decide()` is
  // total, and a context that explodes when touched (a lazy getter, a proxy)
  // must produce a refusal rather than an exception in a security path.
  let approvalId = null;
  let contextError = chosen.error;
  try {
    approvalId = context.approval?.approval_id ?? null;
  } catch (err) {
    contextError = contextError ?? (err instanceof Error ? err.message : String(err));
  }

  return {
    decision_id: newId(),
    outcome: chosen.outcome,
    arm_id: chosen.arm_id,
    reason_code: chosen.reason_code,
    reason: contextError ? `${reason}: ${contextError}` : reason,
    error: contextError ?? null,
    conditions,
    approval_id: approvalId,
    effect_class: effectClass,
    action,
    target,
    decided_at: new Date(now()).toISOString(),
    decided_by: DECIDED_BY,
    // A refusal the caller may come back from with changed circumstances. An
    // indeterminate outcome is never retryable; see arms.mjs.
    retryable: chosen.outcome === 'deny' && chosen.reason_code === 'EXPLICIT_DENIAL',
  };
}

/**
 * True when a decision authorises execution. Callers must use this rather than
 * comparing outcome strings, so that adding an arm cannot silently widen access.
 *
 * @param {Decision} decision
 */
export function permitsExecution(decision) {
  return decision.outcome === 'allow' || decision.outcome === 'allow_with_conditions';
}

/**
 * The condition strings an executor must enforce for a permitting decision.
 * `allow` has none; `allow_with_conditions` must have at least one, and a
 * permitting decision with no conditions and an outcome of
 * `allow_with_conditions` is treated as a defect by the executor.
 *
 * @param {Decision} decision
 */
export function conditionsFor(decision) {
  return permitsExecution(decision) ? [...decision.conditions] : [];
}

/**
 * A record of the decision suitable for the event log. Deliberately a plain
 * object with no functions, so it can be canonicalised and hashed.
 *
 * @param {Decision} decision
 * @param {PolicyRequest} request
 */
export function decisionRecord(decision, request) {
  return {
    decision_id: requireString(decision.decision_id, 'decision_id'),
    outcome: decision.outcome,
    arm_id: decision.arm_id,
    reason_code: decision.reason_code,
    reason: decision.reason,
    conditions: decision.conditions,
    effect_class: decision.effect_class,
    action: decision.action,
    target: decision.target,
    task_id: typeof request?.task_id === 'string' ? request.task_id : null,
    tool_id: typeof request?.tool_id === 'string' ? request.tool_id : null,
    requested_by: typeof request?.requested_by === 'string' ? request.requested_by : null,
    decided_at: decision.decided_at,
    decided_by: decision.decided_by,
    retryable: decision.retryable,
  };
}

export { isRefusal };
