/**
 * Deterministic task replay from persisted task and event records.
 *
 * Replay reads only from the store and never invokes a model, tool, or network
 * endpoint, so post-hoc inspection cannot mutate state or trigger effects.
 */
import { StoreError } from '../core/errors.mjs';

/**
 * @typedef {object} ReplayTimelineEntry
 * @property {number} seq
 * @property {string} event_type
 * @property {string} occurred_at
 * @property {string} producer
 * @property {Record<string, unknown>} payload
 * @property {string} payload_hash
 *
 * @typedef {object} ReplayCounts
 * @property {number} total_events
 * @property {number} policy_decisions
 * @property {number} model_invocations
 * @property {number} tool_executions
 * @property {number} tool_failures
 * @property {number} transitions
 *
 * @typedef {object} ReplayNotFound
 * @property {false} ok
 * @property {false} found
 * @property {string} task_id
 * @property {'TASK_NOT_FOUND'} reason
 *
 * @typedef {object} ReplaySummary
 * @property {boolean} ok
 * @property {true} found
 * @property {string} task_id
 * @property {ReplayTimelineEntry[]} timeline
 * @property {ReplayCounts} counts
 * @property {string|null} final_state
 * @property {import('../core/types.mjs').TaskRecord|null} task
 * @property {import('../core/types.mjs').HistoryRow[]} history
 * @property {{ok: boolean, findings: {code: string}[], state?: string}} verification
 */

/**
 * Reconstruct a deterministic replay summary for a single task.
 *
 * @param {string} taskId
 * @param {{eventLog: import('../core/types.mjs').EventLog, taskStore: import('../core/types.mjs').TaskStore}} stores
 * @returns {ReplayNotFound | ReplaySummary}
 */
export function replayTask(taskId, { eventLog, taskStore }) {
  if (typeof taskId !== 'string' || taskId === '') {
    throw new StoreError('INVALID_TASK_ID', 'taskId must be a non-empty string');
  }

  /** @type {import('../core/types.mjs').TaskRecord|null} */
  let task = null;
  try {
    task = taskStore.get(taskId);
  } catch (err) {
    // openTaskStore().get throws TASK_NOT_FOUND; treat absence as null so
    // event-only logs can still be inspected and missing tasks return a report.
    if (!(err instanceof StoreError && err.code === 'TASK_NOT_FOUND')) throw err;
  }

  /** @type {import('../core/types.mjs').HistoryRow[]} */
  const history = task !== null ? taskStore.history(taskId) : [];
  const verification = taskStore.verify(taskId);
  const events = /** @type {ReplayTimelineEntry[]} */ (eventLog.read({ task_id: taskId, limit: 1_000 }));

  if (task === null && events.length === 0) {
    return { ok: false, found: false, task_id: taskId, reason: 'TASK_NOT_FOUND' };
  }

  const timeline = events.map((e) => ({
    seq: e.seq,
    event_type: e.event_type,
    occurred_at: e.occurred_at,
    producer: e.producer,
    payload: e.payload,
    payload_hash: e.payload_hash,
  }));

  let policyDecisions = 0;
  let modelInvocations = 0;
  let toolExecutions = 0;
  let toolFailures = 0;

  for (const e of timeline) {
    if (e.event_type === 'policy.decided') policyDecisions += 1;
    else if (e.event_type === 'model.invoked') modelInvocations += 1;
    else if (e.event_type === 'tool.executed') {
      toolExecutions += 1;
      if (e.payload?.status === 'error') toolFailures += 1;
    } else if (e.event_type === 'tool.failed') {
      toolFailures += 1;
    }
  }

  return {
    ok: verification.ok,
    found: true,
    task_id: taskId,
    timeline,
    counts: {
      total_events: events.length,
      policy_decisions: policyDecisions,
      model_invocations: modelInvocations,
      tool_executions: toolExecutions,
      tool_failures: toolFailures,
      transitions: history.length,
    },
    final_state: task?.state ?? null,
    task,
    history,
    verification,
  };
}

/**
 * Format a replay report into human-readable lines.
 *
 * @param {ReplayNotFound | ReplaySummary} report
 * @returns {string}
 */
export function formatReplayReport(report) {
  if (!report.found) {
    return [
      `task       ${report.task_id}`,
      `state      unknown (${report.reason})`,
    ].join('\n');
  }

  const c = report.counts;
  const lines = [
    `task       ${report.task_id}`,
    `state      ${report.final_state ?? 'unknown'}`,
    `events     ${c.total_events}`,
    `counts     policy=${c.policy_decisions} model=${c.model_invocations} tool=${c.tool_executions} failures=${c.tool_failures} transitions=${c.transitions}`,
    `verified   ${report.ok ? 'yes' : `no (${report.verification.findings.map((f) => f.code).join(', ')})`}`,
    'timeline:',
  ];

  for (const entry of report.timeline) {
    lines.push(`  ${entry.seq}. [${entry.occurred_at}] ${entry.event_type} (${entry.producer})`);
  }

  return lines.join('\n');
}
