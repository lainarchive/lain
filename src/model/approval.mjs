// Human-approval gate: an external model invocation stops at A5
import { StoreError } from '../core/errors.mjs';
import { requireString } from '../core/validate.mjs';
import { decide, permitsExecution } from '../policy/decide.mjs';
import { buildContext, DEFAULT_RULES } from '../policy/rules.mjs';
import { ModelPolicyError } from './integration.mjs';
import { MODEL_REGISTRY } from './registry.mjs';

/**
 * Thrown when the policy engine hands the decision to a human (A5,
 * `require_approval`). The error carries the recorded decision id so the
 * human's answer can be traced back to the exact decision that asked for it.
 */
export class HumanApprovalNeeded extends Error {
  /**
   * @param {{ taskId: string, modelId: string, decision: import('../policy/decide.mjs').Decision }} args
   */
  constructor({ taskId, modelId, decision }) {
    super(`model ${modelId} requires human approval: ${decision.reason_code} — ${decision.reason}`);
    this.name = 'HumanApprovalNeeded';
    this.code = 'HUMAN_APPROVAL_REQUIRED';
    this.taskId = taskId;
    this.modelId = modelId;
    this.decision = decision;
    this.decision_id = decision.decision_id;
  }
}

/**
 * The gate between a task and a registered model. The policy engine decides —
 * this function never approves by itself. Outcomes: A5 (`require_approval`)
 * throws `HumanApprovalNeeded`; any other refusal throws `ModelPolicyError`;
 * a permitted decision returns with `required: false`. The registry is
 * injectable so tests can exercise the non-external path without adding a
 * falsely-classed entry to the real registry.
 *
 * @param {{ id: string }} task
 * @param {string} modelId
 * @param {{ registry?: typeof MODEL_REGISTRY, rules?: import('../policy/rules.mjs').RuleSet, granted_capabilities?: string[] }} [options]
 * @returns {{ required: boolean, taskId: string, modelId: string, decision_id: string }}
 */
export function requireHumanApproval(task, modelId, options = {}) {
  const taskId = requireString(task?.id, 'task.id');
  const registry = options.registry ?? MODEL_REGISTRY;
  const descriptor = registry[modelId];
  if (!descriptor) {
    throw new StoreError('INVALID_SHAPE', `unknown model id: ${modelId}`, { what: 'model_id' });
  }
  const context = buildContext({
    rules: options.rules ?? DEFAULT_RULES,
    tool_id: 'model.invoke.external',
    granted_capabilities: options.granted_capabilities ?? [],
    budget: { exceeded: false },
    approval: { status: null },
    complete: true,
  });
  const decision = decide(
    {
      action: 'model.invoke.external',
      target: descriptor.id,
      task_id: taskId,
      requested_capabilities: ['model.invoke.external'],
      effect_class: descriptor.effect_class,
      requested_by: 'model-approval',
    },
    context,
  );
  if (decision.outcome === 'require_approval') {
    throw new HumanApprovalNeeded({ taskId, modelId, decision });
  }
  if (!permitsExecution(decision)) throw new ModelPolicyError(decision);
  return { required: false, taskId, modelId, decision_id: decision.decision_id };
}
