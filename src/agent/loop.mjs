/**
 * Bounded model-driven agent loop (M-10).
 *
 * Policy checks and circuit breakers run before every model or tool call so a
 * misbehaving model cannot loop past its budget or bypass authorisation.
 */
import { publishTaskEvent } from '../model/eventBus.mjs';
import { resolveLedgerApproval } from '../model/registry.mjs';
import { decide, permitsExecution } from '../policy/decide.mjs';
import { DEFAULT_RULES, buildContext } from '../policy/rules.mjs';

const DEFAULT_BUDGET = Object.freeze({
  max_steps: 8,
  max_model_calls: 4,
  max_tool_calls: 4,
  max_wall_ms: 30_000,
});

/**
 * @typedef { { type: 'final', answer: string }
 *   | { type: 'tool', tool_id: string, arguments: Record<string, unknown> } } ModelAction
 */

/**
 * Parse a model response (raw JSON string, fenced json block, or plain object)
 * into a validated action.
 *
 * @param {unknown} raw
 * @returns {{ ok: true, action: ModelAction, error?: never } | { ok: false, error: string, action?: never }}
 */
export function parseModelAction(raw) {
  let candidate = raw;
  if (typeof candidate === 'string') {
    const trimmed = candidate.trim();
    const fenceMatch = trimmed.match(/^```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?```$/i);
    const jsonText = fenceMatch ? (fenceMatch[1] ?? '').trim() : trimmed;
    try {
      candidate = JSON.parse(jsonText);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'invalid JSON' };
    }
  }

  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { ok: false, error: 'action must be a JSON object' };
  }

  const obj = /** @type {Record<string, unknown>} */ (candidate);
  if (obj.type === 'final') {
    if (typeof obj.answer !== 'string') {
      return { ok: false, error: 'final action requires a string answer' };
    }
    return { ok: true, action: { type: 'final', answer: obj.answer } };
  }

  if (obj.type === 'tool') {
    if (typeof obj.tool_id !== 'string' || obj.tool_id.length === 0) {
      return { ok: false, error: 'tool action requires a non-empty tool_id' };
    }
    if (
      obj.arguments !== undefined &&
      (obj.arguments === null || typeof obj.arguments !== 'object' || Array.isArray(obj.arguments))
    ) {
      return { ok: false, error: 'tool arguments must be a plain object' };
    }
    const args = /** @type {Record<string, unknown>} */ (obj.arguments ?? {});
    return { ok: true, action: { type: 'tool', tool_id: obj.tool_id, arguments: args } };
  }

  return { ok: false, error: `unsupported action type: ${String(obj.type)}` };
}

/**
 * @param {object} options
 * @param {string} options.taskId
 * @param {string} options.objective
 * @param {{ max_steps?: number, max_model_calls?: number, max_tool_calls?: number, max_wall_ms?: number }} [options.budget]
 * @param {import('../policy/rules.mjs').RuleSet} [options.rules]
 * @param {string[]} [options.granted_capabilities]
 * @param {boolean} [options.live]
 * @param {string} [options.approvalId]
 * @param {import('../model/registry.mjs').LedgerLike} [options.ledger]
 * @param {(ctx: { step: number, messages: Array<{ role: string, content: string }>, taskId: string }) =>
 *   Promise<{ answer: string, cost?: number, model?: string, provider?: string }>
 *   | { answer: string, cost?: number, model?: string, provider?: string }} [options.transport]
 * @param {{ invoke: (args: any) => Promise<any> } | null} [options.invoker]
 * @param {Record<string, any>} [options.toolDecisions]
 * @param {(toolId: string, args: unknown) => any} [options.decideTool]
 * @param {(event: { event_type: string, payload?: Record<string, unknown> }) => void} [options.record]
 * @param {() => number} [options.now]
 */
export async function runModelLoop(options) {
  const {
    taskId,
    objective,
    rules = DEFAULT_RULES,
    granted_capabilities = [],
    live = false,
    approvalId,
    ledger,
    invoker = null,
    toolDecisions,
    decideTool,
    record,
    now = Date.now,
  } = options;

  const budget = {
    max_steps: options.budget?.max_steps ?? DEFAULT_BUDGET.max_steps,
    max_model_calls: options.budget?.max_model_calls ?? DEFAULT_BUDGET.max_model_calls,
    max_tool_calls: options.budget?.max_tool_calls ?? DEFAULT_BUDGET.max_tool_calls,
    max_wall_ms: options.budget?.max_wall_ms ?? DEFAULT_BUDGET.max_wall_ms,
  };

  const transport =
    options.transport ??
    (() => ({ answer: JSON.stringify({ type: 'final', answer: 'mock-ok' }), cost: 0, model: 'mock', provider: 'local' }));

  const emit = (/** @type {string} */ event_type, /** @type {Record<string, unknown>} */ payload = {}) => {
    try {
      record?.({ event_type, payload });
    } catch {
      // Observer failures must not abort or mask loop outcomes.
    }
    try {
      publishTaskEvent({
        event_type,
        payload,
        task_id: taskId,
        occurred_at: new Date(now()).toISOString(),
      });
    } catch {
      // Fire-and-forget: bus failures stay isolated from the runner.
    }
  };

  const fail = (
    /** @type {string} */ status,
    /** @type {string} */ reason,
    /** @type {Record<string, unknown>} */ extra,
    /** @type {number} */ steps,
    /** @type {number} */ model_calls,
    /** @type {number} */ tool_calls,
  ) => {
    emit('loop.failed', { status, reason, steps, model_calls, tool_calls });
    return { status, reason, ...extra, steps, model_calls, tool_calls };
  };

  const startedAt = now();
  let steps = 0;
  let model_calls = 0;
  let tool_calls = 0;
  let consecutiveMalformed = 0;

  /** @type {Array<{ role: string, content: string }>} */
  const messages = [{ role: 'user', content: objective }];

  emit('loop.started', { objective, budget, live });

  while (true) {
    if (now() - startedAt >= budget.max_wall_ms) {
      return fail('budget_exceeded', 'WALL_CLOCK_BUDGET', {}, steps, model_calls, tool_calls);
    }
    if (steps >= budget.max_steps) {
      return fail('budget_exceeded', 'STEP_BUDGET', {}, steps, model_calls, tool_calls);
    }
    if (model_calls >= budget.max_model_calls) {
      return fail('budget_exceeded', 'MODEL_CALL_BUDGET', {}, steps, model_calls, tool_calls);
    }

    const modelToolId = live ? 'model.invoke.external' : 'model.invoke';
    let effectiveGrants = [...granted_capabilities];
    /** @type {{ status: 'pending' | 'granted' | 'denied' | 'timed_out' | null, approval_id?: string }} */
    let approval = { status: null };

    if (live && typeof approvalId === 'string') {
      const resolution = resolveLedgerApproval(approvalId, { ledger, taskId });
      if (resolution.entry !== null) {
        approval = {
          status: /** @type {'pending' | 'granted' | 'denied' | 'timed_out'} */ (resolution.entry.outcome),
          approval_id: resolution.entry.decision_id,
        };
      }
      if (resolution.approved) {
        effectiveGrants = [...new Set([...effectiveGrants, 'model.invoke.external'])];
      }
    }

    const policyContext = buildContext({
      rules,
      tool_id: modelToolId,
      granted_capabilities: effectiveGrants,
      budget: { exceeded: false },
      approval,
      complete: true,
    });
    const decision = decide(
      {
        action: 'model.invoke',
        target: taskId,
        task_id: taskId,
        tool_id: modelToolId,
        requested_capabilities: live ? ['model.invoke.external'] : ['model.invoke'],
        effect_class: live ? 'external' : 'read_only',
        requested_by: 'agent-loop',
      },
      policyContext,
      { now },
    );

    if (!permitsExecution(decision)) {
      return fail('refused', decision.reason_code, { decision }, steps, model_calls, tool_calls);
    }

    steps += 1;
    model_calls += 1;

    let response;
    try {
      response = await transport({ step: steps, messages: [...messages], taskId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return fail('failed', 'MODEL_TRANSPORT_ERROR', { error: message }, steps, model_calls, tool_calls);
    }

    emit('model.invoked', {
      step: steps,
      model: response?.model ?? null,
      provider: response?.provider ?? null,
      cost: response?.cost ?? 0,
    });

    const rawAnswer = response?.answer ?? '';
    messages.push({ role: 'assistant', content: String(rawAnswer) });

    const parsed = parseModelAction(rawAnswer);
    if (!parsed.ok || !parsed.action) {
      consecutiveMalformed += 1;
      if (consecutiveMalformed >= 2) {
        return fail('failed', 'MALFORMED_MODEL_ACTION', { error: parsed.error ?? 'malformed action' }, steps, model_calls, tool_calls);
      }
      // Allow one repair turn when budget permits; a second consecutive failure
      // closes the loop rather than burning the rest of the step budget.
      messages.push({
        role: 'user',
        content: `Invalid action (${parsed.error ?? 'malformed action'}). Reply with JSON: {"type":"final","answer":"..."} or {"type":"tool","tool_id":"...","arguments":{...}}.`,
      });
      continue;
    }

    consecutiveMalformed = 0;
    const action = parsed.action;

    if (action.type === 'final') {
      emit('loop.completed', { status: 'completed', answer: action.answer, steps, model_calls, tool_calls });
      return {
        status: 'completed',
        answer: action.answer,
        steps,
        model_calls,
        tool_calls,
        messages,
      };
    }

    if (tool_calls >= budget.max_tool_calls) {
      return fail('budget_exceeded', 'TOOL_CALL_BUDGET', {}, steps, model_calls, tool_calls);
    }

    const toolDecision = decideTool ? decideTool(action.tool_id, action.arguments) : toolDecisions?.[action.tool_id];
    if (!invoker || typeof invoker.invoke !== 'function' || !toolDecision || !permitsExecution(toolDecision)) {
      return fail('refused', 'TOOL_NOT_PERMITTED', { decision: toolDecision ?? null, tool_id: action.tool_id }, steps, model_calls, tool_calls);
    }

    tool_calls += 1;
    emit('tool.dispatched', {
      step: steps,
      tool_id: action.tool_id,
      decision_id: toolDecision.decision_id ?? null,
    });

    const toolResult = await invoker.invoke({
      tool_id: action.tool_id,
      arguments: action.arguments,
      decision: toolDecision,
      task_id: taskId,
      capabilities: effectiveGrants,
      budget: {
        remaining_tool_calls: budget.max_tool_calls - tool_calls,
        max_output_bytes: 65_536,
        max_wall_ms: budget.max_wall_ms,
      },
    });

    messages.push({
      role: 'tool',
      content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult),
    });
  }
}
