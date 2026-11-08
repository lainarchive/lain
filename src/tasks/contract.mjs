/**
 * Task contract.
 *
 * The single rule that makes "completed" mean anything: **a task with no
 * checkable acceptance criterion is not admitted.** Everything else here is
 * shape validation.
 *
 * Capabilities are granted at admission and are immutable afterwards. A running
 * task that wants a new capability is a *new admission decision*, which is a
 * policy question — never a field the runner may edit.
 */
import { requireString, requireRecord } from '../core/validate.mjs';
import { isUlid } from '../core/ids.mjs';
import { EFFECT_CLASSES, normaliseEffectClass } from '../policy/arms.mjs';

export const CRITERION_KINDS = ['command', 'artifact', 'assertion'];
export const TASK_STATES = [
  'submitted',
  'admitted',
  'running',
  'cancelling',
  'completed',
  'failed',
  'cancelled',
  'cancel_failed',
  'indeterminate',
];

export class TaskContractError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {object} [detail]
   */
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'TaskContractError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Validate a task draft. Throws `TaskContractError` with a stable code; the
 * caller records the code rather than a sentence.
 *
 * @param {unknown} draft
 * @param {{now?: () => number}} [options]
 * @returns {import('../core/types.mjs').TaskContract}
 */
export function validateTaskDraft(draft, options = {}) {
  const now = options.now ?? Date.now;
  const record = requireRecord(draft, 'task');
  const objective = requireString(record.objective, 'objective', { min: 3, max: 4_000 });
  const criteria = record.acceptance_criteria;

  if (!Array.isArray(criteria) || criteria.length === 0) {
    throw new TaskContractError(
      'NO_ACCEPTANCE_CRITERIA',
      'a task must declare at least one acceptance criterion, or its completion cannot be checked',
    );
  }
  if (!criteria.some((c) => requireRecord(c, 'criterion').required !== false)) {
    throw new TaskContractError(
      'NO_REQUIRED_CRITERION',
      'a task must declare at least one criterion marked required; otherwise every check is optional',
    );
  }

  const validatedCriteria = criteria.map((raw, index) => {
    const criterion = requireRecord(raw, `acceptance_criteria[${index}]`);
    const id = requireString(criterion.id, `acceptance_criteria[${index}].id`, { min: 1, max: 64 });
    const statement = requireString(criterion.statement, `acceptance_criteria[${index}].statement`, { min: 3, max: 500 });
    const check = requireRecord(criterion.check, `acceptance_criteria[${index}].check`);
    const kind = requireString(check.kind, `acceptance_criteria[${index}].check.kind`);
    if (kind !== 'command' && kind !== 'artifact' && kind !== 'assertion') {
      throw new TaskContractError('UNKNOWN_CRITERION_KIND', `criterion ${id} has check kind "${kind}"`, { id, kind });
    }
    // Only the fields the criterion actually declares are written. An explicitly
    // `undefined` property is not the same as an absent one: the store
    // canonicalizes before it hashes, and its canonicalizer refuses an undefined
    // property rather than inventing a representation for it. The earlier
    // version wrote `path: undefined` and every task creation failed with
    // `cannot canonicalize an undefined property at ….check.exit_code`.
    /** @type {import('../core/types.mjs').CriterionCheck} */
    const validatedCheck = { kind };
    if (typeof check.path === 'string') validatedCheck.path = check.path;
    if (typeof check.exit_code === 'number') validatedCheck.exit_code = check.exit_code;
    if (typeof check.spec === 'string') validatedCheck.spec = check.spec;
    if (check.extra !== undefined) validatedCheck.extra = check.extra;

    /** @type {import('../core/types.mjs').Criterion} */
    const validated = {
      id,
      statement,
      check: validatedCheck,
      required: criterion.required !== false,
    };
    return validated;
  });

  const effectClass = normaliseEffectClass(record.effect_class ?? 'local_reversible');
  const capabilities = Array.isArray(record.capabilities)
    ? record.capabilities.map((/** @type {unknown} */ c) => requireString(c, 'capability'))
    : [];

  /** @type {import('../core/types.mjs').TaskBudget} */
  const budget = normaliseBudget(record.budget);
  return {
    objective,
    acceptance_criteria: validatedCriteria,
    capabilities,
    effect_class: effectClass,
    effect_class_known: EFFECT_CLASSES.includes(/** @type {string} */ (record.effect_class)),
    workspace: typeof record.workspace === 'string' ? record.workspace : null,
    budget,
    requested_at: new Date(now()).toISOString(),
  };
}

/**
 * Budgets are ceilings, and an absent ceiling is not an unlimited one. Every
 * field has a conservative default so that a task cannot opt out of limits by
 * omitting them.
 *
 * @param {unknown} raw
 * @returns {import('../core/types.mjs').TaskBudget}
 */
export function normaliseBudget(raw) {
  const record = raw && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {};
  /**
   * @param {unknown} value
   * @param {number} fallback
   * @param {number} ceiling
   */
  const num = (value, fallback, ceiling) => {
    const n = typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
    return Math.min(n, ceiling);
  };
  return {
    max_tool_calls: num(record.max_tool_calls, 8, 100),
    max_processes: num(record.max_processes, 1, 3),
    max_wall_ms: num(record.max_wall_ms, 60_000, 1_800_000),
    max_output_bytes: num(record.max_output_bytes, 65_536, 1_048_576),
    max_model_calls: num(record.max_model_calls, 0, 100),
  };
}

/**
 * @param {unknown} value
 */
export function isTaskId(value) {
  return typeof value === 'string' && isUlid(value);
}
