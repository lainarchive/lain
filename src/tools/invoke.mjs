/**
 * Tool invocation.
 *
 * The gate that matters: **no invocation proceeds without a recorded decision.**
 * The decision is written to the event log *before* the tool runs, so a process
 * that dies mid-call leaves evidence of what it was authorised to do rather than
 * a mystery.
 *
 * `denied` and `error` are different outcomes and stay different. A denial is
 * the policy working; an error is the tool failing. Collapsing them would make
 * "the agent tried to do something it was not allowed to do" indistinguishable
 * from "the tool crashed", which is the first thing anyone investigating an
 * incident needs to know.
 */
import { LainError } from '../core/errors.mjs';
import { permitsExecution, conditionsFor } from '../policy/decide.mjs';

export class ToolError extends LainError {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [detail]
   */
  constructor(code, message, detail = {}) {
    super(code, message, detail);
    this.name = 'ToolError';
  }
}

/**
 * @param {object} args
 * @param {import('../core/types.mjs').Registry} args.registry
 * @param {(event: {event_type: string, payload?: Record<string, unknown>, task_id?: string, correlation_id?: string, causation_id?: string}) => unknown} args.record
 * @param {import('../core/types.mjs').WorkspaceHandle} args.workspace
 */
export function createInvoker({ registry, record, workspace }) {
  return {
    /**
     * @param {object} args
     * @param {string} args.tool_id
     * @param {Record<string, unknown>} args.arguments
     * @param {import('../core/types.mjs').PolicyDecision} args.decision
     * @param {string} args.task_id
     * @param {string[]} args.capabilities
     * @param {{remaining_tool_calls: number, max_output_bytes: number, max_wall_ms: number}} args.budget
     * @returns {Promise<import('../core/types.mjs').ToolOutcome>}
     */
    async invoke({ tool_id, arguments: callArgs, decision, task_id, capabilities, budget }) {
      if (!decision || typeof decision.decision_id !== 'string') {
        throw new ToolError('NO_DECISION', 'a tool invocation requires a decision that was recorded before the call');
      }
      // The decision must be written down before the effect, not after.
      record({
        event_type: 'policy.decided',
        task_id,
        correlation_id: decision.decision_id,
        payload: { action: decision.action, outcome: decision.outcome, arm_id: decision.arm_id, reason_code: decision.reason_code },
      });

      if (!permitsExecution(decision)) {
        return {
          status: 'denied',
          decision_id: decision.decision_id,
          outcome: decision.outcome,
          reason_code: decision.reason_code,
          executed: false,
        };
      }

      const tool = registry.get(tool_id);
      if (!tool) {
        return { status: 'denied', decision_id: decision.decision_id, outcome: 'deny', reason_code: 'TOOL_NOT_REGISTERED', executed: false };
      }

      const missing = tool.requires.filter((cap) => !capabilities.includes(cap));
      if (missing.length > 0) {
        return { status: 'denied', decision_id: decision.decision_id, outcome: 'deny', reason_code: 'CAPABILITY_NOT_GRANTED', missing, executed: false };
      }

      if (budget.remaining_tool_calls <= 0) {
        return { status: 'denied', decision_id: decision.decision_id, outcome: 'deny_budget', reason_code: 'TOOL_CALL_BUDGET', executed: false };
      }

      const conditions = conditionsFor(decision);
      const started = Date.now();
      try {
        const result = await tool.run(callArgs, {
          workspace,
          capabilities,
          conditions,
          budget,
          decision,
        });
        const outcome = {
          status: result?.status === 'error' ? 'error' : 'ok',
          decision_id: decision.decision_id,
          tool_id,
          executed: true,
          result,
          duration_ms: Date.now() - started,
          conditions,
        };
        record({
          event_type: 'tool.executed',
          task_id,
          correlation_id: decision.decision_id,
          causation_id: decision.decision_id,
          payload: { tool_id, status: outcome.status, exit_code: result?.exit_code ?? null, duration_ms: outcome.duration_ms, conditions },
        });
        return outcome;
      } catch (err) {
        const error = /** @type {LainError} */ (err);
        record({
          event_type: 'tool.failed',
          task_id,
          correlation_id: decision.decision_id,
          causation_id: decision.decision_id,
          payload: { tool_id, code: error.code ?? 'TOOL_ERROR', message: error.message },
        });
        return {
          status: 'error',
          decision_id: decision.decision_id,
          tool_id,
          executed: true,
          error: { code: error.code ?? 'TOOL_ERROR', message: error.message },
          duration_ms: Date.now() - started,
        };
      }
    },
  };
}
