/**
 * Bounded specialist delegation core (Phase 5).
 *
 * Child agents run under strictly attenuated capabilities and budgets, bounded
 * delegation depth, and an independent deliverable verification gate.
 */
import { randomUUID } from 'node:crypto';
import { publishTaskEvent } from '../model/eventBus.mjs';
import { runModelLoop } from './loop.mjs';

const MAX_OBJECTIVE_CHARS = 2000;
const MAX_CONTEXT_NOTES_CHARS = 2000;
const DEFAULT_WALL_MS = 30_000;

/** @type {Readonly<Record<string, Readonly<{ allowed_capabilities: readonly string[], max_steps: number, max_model_calls: number, max_tool_calls: number }>>>} */
export const SPECIALISTS = Object.freeze({
  researcher: Object.freeze({
    allowed_capabilities: Object.freeze(['model.invoke']),
    max_steps: 4,
    max_model_calls: 2,
    max_tool_calls: 0,
  }),
  implementer: Object.freeze({
    allowed_capabilities: Object.freeze(['model.invoke', 'workspace.write', 'process.spawn']),
    max_steps: 8,
    max_model_calls: 4,
    max_tool_calls: 4,
  }),
  verifier: Object.freeze({
    allowed_capabilities: Object.freeze(['model.invoke']),
    max_steps: 4,
    max_model_calls: 2,
    max_tool_calls: 0,
  }),
});

/**
 * Intersect parent, specialist, and requested capabilities so a delegated
 * child can never escalate beyond its parent or specialist profile.
 *
 * @param {readonly string[]} parentCaps
 * @param {readonly string[]} specialistAllowed
 * @param {readonly string[] | null | undefined} [requestedCaps]
 * @returns {string[]}
 */
export function attenuateCapabilities(parentCaps, specialistAllowed, requestedCaps) {
  const parentSet = new Set(Array.isArray(parentCaps) ? parentCaps : []);
  const specialistList = Array.isArray(specialistAllowed) ? specialistAllowed : [];
  const requestedSet = new Set(Array.isArray(requestedCaps) ? requestedCaps : specialistList);

  /** @type {string[]} */
  const granted = [];
  for (const cap of new Set(specialistList)) {
    if (typeof cap === 'string' && parentSet.has(cap) && requestedSet.has(cap)) {
      granted.push(cap);
    }
  }
  return granted;
}

/**
 * @param {unknown} parentVal
 * @param {unknown} childVal
 * @param {number} fallback
 * @returns {number}
 */
function clampNonNegativeInt(parentVal, childVal, fallback) {
  /** @type {number[]} */
  const candidates = [];
  if (typeof parentVal === 'number' && Number.isFinite(parentVal)) {
    candidates.push(parentVal);
  }
  if (typeof childVal === 'number' && Number.isFinite(childVal)) {
    candidates.push(childVal);
  }
  const raw = candidates.length > 0 ? Math.min(...candidates) : fallback;
  return Math.max(0, Math.floor(raw));
}

/**
 * Clamp a child budget against the parent's remaining budget.
 *
 * @param {{ max_steps?: number, max_model_calls?: number, max_tool_calls?: number, max_wall_ms?: number } | null | undefined} parentRemaining
 * @param {{ max_steps?: number, max_model_calls?: number, max_tool_calls?: number, max_wall_ms?: number } | null | undefined} childRequested
 * @returns {{ max_steps: number, max_model_calls: number, max_tool_calls: number, max_wall_ms: number }}
 */
export function attenuateBudget(parentRemaining, childRequested) {
  const parent = parentRemaining ?? {};
  const child = childRequested ?? {};
  // Fail closed: an omitted or non-numeric parent ceiling yields 0, never the child request.
  const parentBound = (/** @type {unknown} */ val) => (typeof val === 'number' && Number.isFinite(val) ? val : 0);
  return {
    max_steps: clampNonNegativeInt(parentBound(parent.max_steps), child.max_steps, 0),
    max_model_calls: clampNonNegativeInt(parentBound(parent.max_model_calls), child.max_model_calls, 0),
    max_tool_calls: clampNonNegativeInt(parentBound(parent.max_tool_calls), child.max_tool_calls, 0),
    max_wall_ms: clampNonNegativeInt(parentBound(parent.max_wall_ms), child.max_wall_ms, 0),
  };
}

/**
 * @param {string} text
 * @param {number} maxChars
 * @returns {string}
 */
function capText(text, maxChars) {
  const trimmed = String(text ?? '').trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars - 3)}...`;
}

/**
 * @param {string} specialistId
 * @param {string} objective
 * @param {string | undefined} contextNotes
 * @returns {string}
 */
function buildBoundedPrompt(specialistId, objective, contextNotes) {
  const boundedObjective = capText(objective, MAX_OBJECTIVE_CHARS);
  const boundedNotes = contextNotes ? capText(contextNotes, MAX_CONTEXT_NOTES_CHARS) : '';
  if (!boundedNotes) {
    return `[Specialist: ${specialistId}]\nObjective: ${boundedObjective}`;
  }
  return `[Specialist: ${specialistId}]\nObjective: ${boundedObjective}\nContext:\n${boundedNotes}`;
}

/**
 * Delegate a bounded subtask to a known specialist profile.
 *
 * @param {object} options
 * @param {string} options.parentTaskId
 * @param {string} options.specialistId
 * @param {string} options.objective
 * @param {readonly string[]} options.parentCapabilities
 * @param {{ max_steps?: number, max_model_calls?: number, max_tool_calls?: number, max_wall_ms?: number }} options.parentBudget
 * @param {readonly string[]} [options.requestedCapabilities]
 * @param {{ max_steps?: number, max_model_calls?: number, max_tool_calls?: number, max_wall_ms?: number }} [options.requestedBudget]
 * @param {string} [options.contextNotes]
 * @param {number} [options.depth=0]
 * @param {number} [options.maxDepth=2]
 * @param {number} [options.activeChildren=0]
 * @param {number} [options.maxLiveAgents=4]
 * @param {(ctx: { step: number, messages: Array<{ role: string, content: string }>, taskId: string }) =>
 *   Promise<{ answer: string, cost?: number, model?: string, provider?: string }>
 *   | { answer: string, cost?: number, model?: string, provider?: string }} [options.transport]
 * @param {{ invoke: (args: any) => Promise<any> } | null} [options.invoker]
 * @param {Record<string, any>} [options.toolDecisions]
 * @param {(toolId: string, args: unknown) => any} [options.decideTool]
 * @param {import('../policy/rules.mjs').RuleSet} [options.rules]
 * @param {(outcome: any) => Promise<{ ok: boolean, note?: string }> | { ok: boolean, note?: string }} [options.verifyDeliverable]
 * @param {(event: { event_type: string, payload?: Record<string, unknown> }) => void} [options.record]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function delegateTask(options) {
  const {
    parentTaskId,
    specialistId,
    objective,
    parentCapabilities,
    parentBudget,
    requestedCapabilities,
    requestedBudget,
    contextNotes,
    depth = 0,
    maxDepth = 2,
    activeChildren = 0,
    maxLiveAgents = 4,
    transport,
    invoker,
    toolDecisions,
    decideTool,
    rules,
    verifyDeliverable,
    record,
  } = options;

  const specialist = Object.hasOwn(SPECIALISTS, specialistId) ? SPECIALISTS[specialistId] : undefined;
  if (!specialist) {
    return { status: 'refused', reason: 'UNKNOWN_SPECIALIST' };
  }

  if (!Number.isInteger(depth) || depth < 0 || !Number.isInteger(maxDepth) || maxDepth < 1 || depth >= maxDepth) {
    return {
      status: 'refused',
      reason: 'DELEGATION_DEPTH_EXCEEDED',
      depth,
      max_depth: maxDepth,
    };
  }

  if (!Number.isInteger(activeChildren) || activeChildren < 0 || !Number.isInteger(maxLiveAgents) || maxLiveAgents < 1 || activeChildren >= maxLiveAgents) {
    return { status: 'refused', reason: 'MAX_LIVE_AGENTS_EXCEEDED' };
  }

  const granted_capabilities = attenuateCapabilities(
    parentCapabilities,
    specialist.allowed_capabilities,
    requestedCapabilities,
  );

  // Clamp requestedBudget against the specialist ceiling first so a caller
  // cannot ask for more steps/calls than the specialist profile permits.
  const specialistBoundedRequest = {
    max_steps: clampNonNegativeInt(specialist.max_steps, requestedBudget?.max_steps, specialist.max_steps),
    max_model_calls: clampNonNegativeInt(specialist.max_model_calls, requestedBudget?.max_model_calls, specialist.max_model_calls),
    max_tool_calls: clampNonNegativeInt(specialist.max_tool_calls, requestedBudget?.max_tool_calls, specialist.max_tool_calls),
    max_wall_ms: requestedBudget?.max_wall_ms ?? DEFAULT_WALL_MS,
  };
  const attenuatedBudget = attenuateBudget(parentBudget, specialistBoundedRequest);

  if (attenuatedBudget.max_model_calls <= 0 || attenuatedBudget.max_steps <= 0 || attenuatedBudget.max_wall_ms <= 0) {
    return { status: 'refused', reason: 'BUDGET_EXCEEDED' };
  }

  const child_task_id = `${parentTaskId}:child:${specialistId}:${randomUUID().slice(0, 8)}`;
  const prompt = buildBoundedPrompt(specialistId, objective, contextNotes);

  const emit = (/** @type {string} */ event_type, /** @type {Record<string, unknown>} */ payload = {}) => {
    try {
      record?.({ event_type, payload });
    } catch {
      // Observer failures must not mask delegation outcomes.
    }
    try {
      publishTaskEvent({
        event_type,
        payload,
        task_id: child_task_id,
        occurred_at: new Date().toISOString(),
      });
    } catch {
      // Fire-and-forget: bus failures stay isolated.
    }
  };

  emit('delegation.started', {
    parent_task_id: parentTaskId,
    child_task_id,
    specialist: specialistId,
    depth: depth + 1,
    granted_capabilities,
    budget: attenuatedBudget,
  });

  const outcome = await runModelLoop({
    taskId: child_task_id,
    objective: prompt,
    budget: attenuatedBudget,
    granted_capabilities,
    transport,
    invoker,
    toolDecisions,
    decideTool,
    rules,
    record,
  });

  let verified = false;
  /** @type {string | undefined} */
  let verification_note;

  if (outcome.status === 'completed') {
    if (typeof verifyDeliverable === 'function') {
      try {
        const result = await verifyDeliverable(outcome);
        verified = Boolean(result?.ok);
        verification_note = result?.note;
      } catch (err) {
        verified = false;
        verification_note = err instanceof Error ? err.message : String(err);
      }
    } else {
      verified = true;
    }
  }

  const finalStatus = outcome.status !== 'completed' ? outcome.status : verified ? 'completed' : 'verification_failed';
  emit(finalStatus === 'completed' ? 'delegation.completed' : 'delegation.failed', {
    parent_task_id: parentTaskId,
    child_task_id,
    specialist: specialistId,
    depth: depth + 1,
    status: finalStatus,
    verified,
    verification_note,
    outcome_status: outcome.status,
  });

  return {
    status: finalStatus,
    specialist: specialistId,
    depth: depth + 1,
    child_task_id,
    granted_capabilities,
    budget: attenuatedBudget,
    outcome,
    verified,
    verification_note,
  };
}
