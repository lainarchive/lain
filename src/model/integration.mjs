/**
 * @generated
 * @purpose  Mock model integration for M-2: one decided, selected, invoked call
 * @requires Chief-of-Staff
 */
import { StoreError } from '../core/errors.mjs';
import { requireRecord, requireString } from '../core/validate.mjs';
import { decide, permitsExecution } from '../policy/decide.mjs';
import { buildContext, DEFAULT_RULES } from '../policy/rules.mjs';
import { localModel } from './localModel.mjs';
import { selectModel } from './selectModel.mjs';

/**
 * A refusal that carries the recorded decision. The policy engine itself never
 * throws — `decide()` is total by construction — so a caller that catches this
 * sees the decision, not a crash, and the decision id is already in the record.
 */
export class ModelPolicyError extends Error {
  /**
   * @param {import('../policy/decide.mjs').Decision} decision
   */
  constructor(decision) {
    super(`model invocation refused: ${decision.reason_code} — ${decision.reason}`);
    this.name = 'ModelPolicyError';
    this.code = 'MODEL_POLICY_REFUSED';
    this.decision = decision;
  }
}

/**
 * Shape-check the task before anything else sees it. `required_capabilities`
 * must be a non-empty array of non-empty strings: an empty requirement set
 * would make the grant check true by construction, which is exactly the
 * defect the admission intersection in the task runner exists to prevent.
 *
 * @param {unknown} task
 * @returns {{ id: string, prompt: string, required_capabilities: string[] }}
 */
export function validateModelTask(task) {
  const record = requireRecord(task, 'task');
  const id = requireString(record.id, 'task.id');
  const prompt = requireString(record.prompt, 'task.prompt');
  const caps = record.required_capabilities;
  if (
    !Array.isArray(caps) ||
    caps.length === 0 ||
    caps.some((/** @type {unknown} */ cap) => typeof cap !== 'string' || cap.length === 0)
  ) {
    throw new StoreError(
      'INVALID_SHAPE',
      'task.required_capabilities must be a non-empty array of non-empty strings',
      { what: 'task.required_capabilities' },
    );
  }
  return { id, prompt, required_capabilities: /** @type {string[]} */ (caps) };
}

/**
 * Run one model invocation the way the runner runs a tool: the policy decides
 * first, and nothing is selected or invoked without a permitting decision.
 * The effect class is `read_only` because the mock changes nothing and
 * reaches nothing; a real provider in M-3 must move it to `external`, which
 * lands in A5 and asks a human before it runs.
 *
 * @param {unknown} task
 * @param {{ rules?: import('../policy/rules.mjs').RuleSet, granted_capabilities?: string[] }} [options]
 * @returns {{ taskId: string, model: { provider: string, name: string, cost: number }, result: { answer: string, echo: string }, decision_id: string }}
 */
export function runTask(task, options = {}) {
  const clean = validateModelTask(task);
  const context = buildContext({
    rules: options.rules ?? DEFAULT_RULES,
    tool_id: 'model.invoke',
    granted_capabilities: options.granted_capabilities ?? [],
    budget: { exceeded: false },
    approval: { status: null },
    complete: true,
  });
  const decision = decide(
    {
      action: 'model.invoke',
      target: clean.id,
      task_id: clean.id,
      requested_capabilities: clean.required_capabilities,
      effect_class: 'read_only',
      requested_by: 'model-integration',
    },
    context,
  );
  if (!permitsExecution(decision)) throw new ModelPolicyError(decision);
  const model = selectModel(clean);
  const result = localModel(clean.prompt);
  return { taskId: clean.id, model, result, decision_id: decision.decision_id };
}
