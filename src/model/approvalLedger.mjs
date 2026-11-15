/**
 * @generated
 * @purpose  M-5 approval ledger: the durable record of human decisions, gated like everything else
 * @requires Chief-of-Staff
 */
import { StoreError } from '../core/errors.mjs';
import { decide, permitsExecution } from '../policy/decide.mjs';
import { buildContext, DEFAULT_RULES } from '../policy/rules.mjs';
import { ModelPolicyError } from './integration.mjs';

/**
 * The vocabulary a human decision can have. Deliberately the same words the
 * policy engine's approval status uses (`pending`, `granted`, `denied`,
 * `timed_out`) — one vocabulary for one concept, no translation layer to get
 * wrong.
 *
 * @type {string[]}
 */
export const OUTCOMES = ['pending', 'granted', 'denied', 'timed_out'];

/**
 * In-memory for now, keyed by decision id: one decision, one entry, and a
 * duplicate id is refused rather than overwritten — a ledger that silently
 * rewrites history is not a ledger. Persistence (SQLite) is the milestone
 * proper; the Map is the seam it will replace.
 *
 * @type {Map<string, { decision_id: string, taskId: string, modelId: string, outcome: string, at: string, decided_by?: string }>}
 */
const ledger = new Map();

/**
 * Validate one entry's shape. Shape errors are caller errors and are thrown
 * before the policy engine is asked — the gate decides whether a *valid*
 * record may be written, not whether garbage may be written.
 *
 * @param {{ decision_id?: unknown, taskId?: unknown, modelId?: unknown, outcome?: unknown, decided_by?: unknown }} entry
 * @returns {{ decision_id: string, taskId: string, modelId: string, outcome: string, decided_by?: string }}
 */
function requireShape(entry) {
  const keyFields = /** @type {['decision_id', 'taskId', 'modelId']} */ (['decision_id', 'taskId', 'modelId']);
  for (const field of keyFields) {
    if (typeof entry[field] !== 'string' || /** @type {string} */ (entry[field]) === '') {
      throw new StoreError('INVALID_SHAPE', `approval entry needs a non-empty ${field}`, { what: field });
    }
  }
  if (!OUTCOMES.includes(/** @type {string} */ (entry.outcome))) {
    throw new StoreError('INVALID_SHAPE', `approval outcome must be one of: ${OUTCOMES.join(', ')}`, { what: 'outcome' });
  }
  const clean = /** @type {{ decision_id: string, taskId: string, modelId: string, outcome: string, decided_by?: string }} */ (entry);
  if (ledger.has(clean.decision_id)) {
    throw new StoreError('INVALID_SHAPE', `duplicate approval record for decision ${clean.decision_id}`, { what: 'decision_id' });
  }
  return clean;
}
/**
 * Record one human decision. The write goes through the real engine under
 * the `model.approval.record` rule (requires `model.admin`): an audit trail
 * anyone can write is worth nothing, so the gate guards the ledger the same
 * way it guards everything else. The recording time is the ledger's clock,
 * not the caller's.
 *
 * @param {{ decision_id: string, taskId: string, modelId: string, outcome: string, decided_by?: string }} entry
 * @param {{ rules?: import('../policy/rules.mjs').RuleSet, granted_capabilities?: string[] }} [options]
 * @returns {{ decision_id: string, taskId: string, modelId: string, outcome: string, at: string, decided_by?: string }}
 */
export function recordApproval(entry, options = {}) {
  const clean = requireShape(entry);
  const context = buildContext({
    rules: options.rules ?? DEFAULT_RULES,
    tool_id: 'model.approval.record',
    granted_capabilities: options.granted_capabilities ?? [],
    budget: { exceeded: false },
    approval: { status: null },
    complete: true,
  });
  const decision = decide(
    {
      action: 'model.approval.record',
      target: clean.decision_id,
      requested_capabilities: ['model.admin'],
      effect_class: 'local_reversible',
      requested_by: 'model-approval-record',
    },
    context,
  );
  if (!permitsExecution(decision)) throw new ModelPolicyError(decision);
  /** @type {{ decision_id: string, taskId: string, modelId: string, outcome: string, at: string, decided_by?: string }} */
  const stored = {
    decision_id: clean.decision_id,
    taskId: clean.taskId,
    modelId: clean.modelId,
    outcome: clean.outcome,
    at: new Date().toISOString(),
  };
  if (typeof clean.decided_by === 'string' && clean.decided_by !== '') stored.decided_by = clean.decided_by;
  ledger.set(clean.decision_id, stored);
  return stored;
}

/**
 * The ledger, in insertion order — the order decisions were recorded is part
 * of the record. Returned as a deep-enough copy: callers read history, they
 * do not edit it.
 *
 * @returns {Array<{ decision_id: string, taskId: string, modelId: string, outcome: string, at: string, decided_by?: string }>}
 */
export function listApprovals() {
  return [...ledger.values()].map((entry) => ({ ...entry }));
}

/**
 * Test seam: clear the ledger. Never called by production code — recorded
 * decisions are not something a run gets to un-see.
 *
 * @returns {void}
 */
export function resetApprovals() {
  ledger.clear();
}
