/**
 * The policy arms.
 *
 * Eight arms, and every request resolves to exactly one of them. The table is
 * data rather than control flow on purpose: an arm that cannot be reached is
 * invisible in code but obvious in a table, and the whole point of this module
 * is that "allow" is never the answer by default.
 *
 * Ordering is the contract. The list below is evaluated top to bottom and the
 * first arm whose condition holds produces the decision, so a refusal placed
 * above a permission can never be overridden by it.
 */

/** @typedef {'allow'|'allow_with_conditions'|'require_approval'|'defer'|'deny'|'deny_indeterminate'|'deny_budget'|'defer_policy_error'} Outcome */

/**
 * An arm: a name, the outcome it produces, and a predicate over the request and
 * its context. `reason_code` is stable and machine-readable; `condition` (when
 * present) is the condition string recorded on `allow_with_conditions`.
 *
 * @typedef {object} Arm
 * @property {string} id
 * @property {Outcome} outcome
 * @property {string} reason_code
 * @property {(req: import('./decide.mjs').PolicyRequest, ctx: import('./decide.mjs').PolicyContext) => boolean} when
 * @property {string} [condition]
 */

/**
 * Arms that represent a refusal of some kind. Kept as a set because callers ask
 * "may this proceed?" far more often than "which arm fired?".
 * @type {ReadonlySet<Outcome>}
 */
export const REFUSAL_OUTCOMES = new Set([
  'deny',
  'deny_indeterminate',
  'deny_budget',
  'defer',
  'defer_policy_error',
]);

/**
 * The outcome carried by a decision, or the outcome itself.
 *
 * These predicates take either shape because both are natural at a call site:
 * `isRetryableRefusal(decision)` where the decision is in hand, and
 * `isRefusal(arm.outcome)` where only the outcome is. A one-argument string
 * comparison silently returns `false` for a decision object, which is the kind
 * of always-no that turns into a security bug later.
 *
 * @param {Outcome | {outcome: Outcome}} decisionOrOutcome
 * @returns {Outcome}
 */
function outcomeOf(decisionOrOutcome) {
  return decisionOrOutcome && typeof decisionOrOutcome === 'object'
    ? decisionOrOutcome.outcome
    : decisionOrOutcome;
}

/** @param {Outcome | {outcome: Outcome}} decisionOrOutcome */
export function isRefusal(decisionOrOutcome) {
  return REFUSAL_OUTCOMES.has(outcomeOf(decisionOrOutcome));
}

/** @param {Outcome | {outcome: Outcome}} decisionOrOutcome */
export function isTerminalRefusal(decisionOrOutcome) {
  const outcome = outcomeOf(decisionOrOutcome);
  return outcome === 'deny' || outcome === 'deny_budget';
}

/**
 * Whether a refusal may be re-asked at all.
 *
 * Callers pass a `Decision` when they have one, and the bare `Outcome` when they
 * only have that. The decision's own `retryable` field is authoritative when
 * present, because it is computed where the reason code is still known: a `deny`
 * carries different meaning depending on *why* it happened, and `EXPLICIT_DENIAL`
 * (a human said no, which may be re-asked after circumstances change) is the only
 * retryable case. An indeterminate answer is never retryable — the caller never
 * learned the user's intent, so retrying is guessing on the user's behalf.
 *
 * The earlier one-argument form compared the outcome alone, which reported a
 * policy-rule `deny` as retryable; the V-1 policy test caught it.
 *
 * @param {Outcome | {outcome: Outcome, retryable?: boolean}} decisionOrOutcome
 */
export function isRetryableRefusal(decisionOrOutcome) {
  if (decisionOrOutcome && typeof decisionOrOutcome === 'object') {
    if (typeof decisionOrOutcome.retryable === 'boolean') return decisionOrOutcome.retryable;
    return decisionOrOutcome.outcome === 'deny';
  }
  return decisionOrOutcome === 'deny';
}

/** Effect classes, ordered by how much they can cost. */
export const EFFECT_CLASSES = ['read_only', 'local_reversible', 'local_transactional', 'external', 'local_irreversible'];

/**
 * A deliberately conservative default. An effect class that is absent, empty or
 * unrecognised is treated as `external` — the class that requires a human — so a
 * mislabelled tool degrades to asking rather than to acting.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normaliseEffectClass(value) {
  if (typeof value !== 'string') return 'external';
  const found = EFFECT_CLASSES.find((cls) => cls === value);
  return found ?? 'external';
}

/**
 * The arm table. Read it top to bottom: that is the evaluation order.
 *
 * @type {ReadonlyArray<Arm>}
 */
export const ARMS = Object.freeze([
  {
    id: 'A1',
    outcome: 'deny',
    reason_code: 'EXPLICIT_DENIAL',
    // A user said no. Terminal for this request; a *new* request with changed
    // circumstances is the way back, never a silent retry of this one.
    when: (req, ctx) => ctx.approval?.status === 'denied',
  },
  {
    id: 'A2',
    outcome: 'deny_indeterminate',
    reason_code: 'APPROVAL_TIMED_OUT',
    // The approval window closed with no answer. Absence of approval is denial,
    // and because the user's intent was never learned this is NOT retryable.
    when: (req, ctx) => ctx.approval?.status === 'timed_out',
  },
  {
    id: 'A3',
    outcome: 'deny',
    reason_code: 'POLICY_RULE_FORBIDS',
    // An explicit rule forbids this action. Checked before anything is allowed so
    // that a rule can never be shadowed by a permission granted elsewhere.
    when: (req, ctx) => ctx.forbidden === true,
  },
  {
    id: 'A4',
    outcome: 'deny_budget',
    reason_code: 'BUDGET_EXCEEDED',
    // The request is affordable in principle but not now. Distinct from `deny`
    // so a caller can tell "you may not" from "you may not yet".
    when: (req, ctx) => ctx.budget?.exceeded === true,
  },
  {
    id: 'A5',
    outcome: 'require_approval',
    reason_code: 'EFFECT_CLASS_REQUIRES_APPROVAL',
    // Irreversible and external effects need a human. This arm is placed above
    // the permissive ones so no capability grant can reach them without one.
    when: (req, ctx) =>
      normaliseEffectClass(req.effect_class) === 'local_irreversible' || normaliseEffectClass(req.effect_class) === 'external',
  },
  {
    id: 'A6',
    outcome: 'defer',
    reason_code: 'POLICY_EVALUATION_INCOMPLETE',
    // Something the decision needs is unmeasured: no probe, no budget, no rule
    // set. Fail closed by asking, rather than by assuming the answer is yes.
    when: (req, ctx) => ctx.complete === false,
  },
  {
    id: 'A6b',
    outcome: 'defer',
    reason_code: 'CAPABILITY_NOT_GRANTED',
    // The tool needs a capability the task does not hold. Without this arm the
    // request matched nothing and fell through to A9, so a plain refusal was
    // reported as "the policy crashed" — the right answer for the wrong reason,
    // which is how a real evaluation error stops being visible. `defer` rather
    // than `deny`: the task may be admitted later with the authority granted, and
    // that is a different question from "this action is forbidden".
    when: (req, ctx) => ctx.granted === false,
  },
  {
    id: 'A7',
    outcome: 'allow',
    reason_code: 'READ_ONLY_WITHIN_GRANT',
    // The only unconditional yes: an action that changes nothing, asking for a
    // capability the task was actually granted.
    when: (req, ctx) => normaliseEffectClass(req.effect_class) === 'read_only' && ctx.granted === true,
  },
  {
    id: 'A8',
    outcome: 'allow_with_conditions',
    reason_code: 'REVERSIBLE_WITHIN_WORKSPACE',
    condition: 'workspace_only',
    // Reversible local writes are allowed inside the task's workspace and
    // nowhere else. The condition travels with the decision so the executor —
    // never the model — is what enforces it.
    when: (req, ctx) => normaliseEffectClass(req.effect_class) === 'local_reversible' && ctx.granted === true,
  },
  {
    id: 'A9',
    outcome: 'defer_policy_error',
    reason_code: 'EVALUATION_ERROR',
    // The last arm is the safety net for a predicate that threw. It is listed
    // explicitly rather than implied so that "the policy crashed" is a recorded
    // outcome instead of an unhandled exception.
    when: () => true,
  },
]);

/** @param {string} id */
export function armById(id) {
  return ARMS.find((arm) => arm.id === id) ?? null;
}
