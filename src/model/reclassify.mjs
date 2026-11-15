/**
 * @generated
 * @purpose  M-4 re-classification: an authorized, logged, in-memory override of a model's effect class
 * @requires Chief-of-Staff
 */
import { StoreError } from '../core/errors.mjs';
import { decide, permitsExecution } from '../policy/decide.mjs';
import { EFFECT_CLASSES } from '../policy/arms.mjs';
import { buildContext, DEFAULT_RULES } from '../policy/rules.mjs';
import { ModelPolicyError } from './integration.mjs';
import { MODEL_REGISTRY } from './registry.mjs';

/** Thrown when a model id is not in the registry — a caller error, not a policy refusal. */
export class ReclassificationError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'ReclassificationError';
    this.code = 'RECLASSIFICATION_ERROR';
  }
}

/**
 * The shipped registry stays frozen — it is the audited default. A
 * reclassification is an explicit override layered over it, session-scoped
 * and logged with the decision id that authorized it. `effectiveDescriptor`
 * is the view future callers (the approval gate, the provider path) must
 * consult; until the gate is wired to it, an override is recorded but not
 * gate-effective, and that seam is stated in docs/model/provider.md rather
 * than hidden.
 *
 * @type {Map<string, string>}
 */
const overrides = new Map();

/** @type {Array<{ at: string, modelId: string, from: string, to: string, decision_id: string }>} */
const log = [];

/**
 * The descriptor a model presents after any overrides. Unknown ids stay
 * undefined, exactly like the base registry.
 *
 * @param {string} modelId
 * @returns {{ id: string, provider: string, name: string, cost: number, effect_class: string } | undefined}
 */
export function effectiveDescriptor(modelId) {
  const base = MODEL_REGISTRY[modelId];
  if (!base) return undefined;
  const to = overrides.get(modelId);
  return to === undefined ? base : { ...base, effect_class: to };
}

/**
 * Re-classify one model after the policy engine permits it. The rule row is
 * `model.reclassify` (requires `model.admin`): the human operator's CLI path
 * carries that capability because it *is* the operator acting; a task-driven
 * path passes the task's capabilities and is refused without them.
 *
 * @param {string} modelId
 * @param {string} newEffectClass one of EFFECT_CLASSES (src/policy/arms.mjs)
 * @param {{ rules?: import('../policy/rules.mjs').RuleSet, granted_capabilities?: string[] }} [options]
 * @returns {{ modelId: string, from: string, to: string, decision_id: string }}
 */
export function reclassifyModel(modelId, newEffectClass, options = {}) {
  const base = MODEL_REGISTRY[modelId];
  if (!base) throw new ReclassificationError(`no registered model: ${modelId}`);
  if (!EFFECT_CLASSES.includes(newEffectClass)) {
    throw new StoreError('INVALID_SHAPE', `unknown effect class: ${newEffectClass}`, { what: 'new_effect' });
  }
  const context = buildContext({
    rules: options.rules ?? DEFAULT_RULES,
    tool_id: 'model.reclassify',
    granted_capabilities: options.granted_capabilities ?? [],
    budget: { exceeded: false },
    approval: { status: null },
    complete: true,
  });
  const decision = decide(
    {
      action: 'model.reclassify',
      target: modelId,
      requested_capabilities: ['model.admin'],
      effect_class: 'local_reversible',
      requested_by: 'model-reclassify',
    },
    context,
  );
  if (!permitsExecution(decision)) throw new ModelPolicyError(decision);
  const from = /** @type {{ effect_class: string }} */ (effectiveDescriptor(modelId)).effect_class;
  overrides.set(modelId, newEffectClass);
  log.push({ at: new Date().toISOString(), modelId, from, to: newEffectClass, decision_id: decision.decision_id });
  return { modelId, from, to: newEffectClass, decision_id: decision.decision_id };
}

/**
 * The audit trail: every reclassification with its authorizing decision id.
 * Returned as a copy — callers read history, they do not edit it.
 *
 * @returns {Array<{ at: string, modelId: string, from: string, to: string, decision_id: string }>}
 */
export function getReclassificationLog() {
  return [...log];
}

/**
 * Test seam: clear overrides and history. Never called by production code —
 * a reclassification trail is not something a run gets to un-see.
 *
 * @returns {void}
 */
export function resetReclassifications() {
  overrides.clear();
  log.length = 0;
}
