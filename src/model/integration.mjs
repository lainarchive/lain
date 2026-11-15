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
import { resolveLedgerApproval } from './registry.mjs';

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
 * Everything one decided, selected, invoked call produces. The full decision
 * rides along so callers can assert the arm, not just the id.
 *
 * @typedef {{ taskId: string, model: { provider: string, name: string, cost: number },
 *   result: { answer: string, echo: string }, decision_id: string,
 *   decision: import('../policy/decide.mjs').Decision }} RunTaskResult
 */

/**
 * Run one model invocation the way the runner runs a tool: the policy decides
 * first, and nothing is selected or invoked without a permitting decision.
 *
 * The default path stays the M-2 stub: `read_only`, the mock model, no
 * network. With `live: true` the request moves to the `model.invoke.external`
 * row — effect class `external`, so the engine lands it in A5 and asks a
 * human. M-8 closes that loop: pass `approvalId` and the decision is looked
 * up in a ledger (the in-memory module ledger by default, the persistent one
 * in production). A `granted` entry that is bound to this task's id — the
 * approver recorded the approval for THIS task, and the task file can prove
 * which task it is — augments the task's grants with
 * `model.invoke.external` for this invocation; any other outcome feeds the
 * engine as the approval status (denied → A1, timed_out → A2, pending → A5).
 * An unbound or id-less task is never augmented: an approval must not
 * substitute for the capability (the M-7 invariant), it may only supply it
 * for the task it was recorded against.
 *
 * @param {unknown} task
 * @param {{ rules?: import('../policy/rules.mjs').RuleSet, granted_capabilities?: string[], live?: boolean, approvalId?: string, ledger?: import('./registry.mjs').LedgerLike }} [options]
 * @returns {RunTaskResult}
 */
export function runTask(task, options = {}) {
  const clean = validateModelTask(task);
  const live = options.live === true;
  const toolId = live ? 'model.invoke.external' : 'model.invoke';
  let granted = options.granted_capabilities ?? [];
  /** @type {{ status: 'pending' | 'granted' | 'denied' | 'timed_out', approval_id: string } | { status: null }} */
  let approval = { status: null };
  if (live && typeof options.approvalId === 'string') {
    const resolution = resolveLedgerApproval(options.approvalId, { ledger: options.ledger, taskId: clean.id });
    if (resolution.entry !== null) {
      // Both ledgers validate the outcome against OUTCOMES at write time; the
      // cast makes that stored invariant visible to the engine's union here.
      approval = {
        status: /** @type {'pending' | 'granted' | 'denied' | 'timed_out'} */ (resolution.entry.outcome),
        approval_id: resolution.entry.decision_id,
      };
    }
    if (resolution.approved) {
      granted = [...new Set([...granted, 'model.invoke.external'])];
    }
  }
  const context = buildContext({
    rules: options.rules ?? DEFAULT_RULES,
    tool_id: toolId,
    granted_capabilities: granted,
    budget: { exceeded: false },
    approval,
    complete: true,
  });
  const decision = decide(
    {
      action: 'model.invoke',
      target: clean.id,
      task_id: clean.id,
      requested_capabilities: live ? ['model.invoke.external'] : clean.required_capabilities,
      effect_class: live ? 'external' : 'read_only',
      requested_by: 'model-integration',
    },
    context,
  );
  if (!permitsExecution(decision)) throw new ModelPolicyError(decision);
  const model = selectModel(clean);
  const result = localModel(clean.prompt);
  return { taskId: clean.id, model, result, decision_id: decision.decision_id, decision };
}
