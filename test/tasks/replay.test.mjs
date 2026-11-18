import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../../src/store/index.mjs';
import { openTaskStore } from '../../src/tasks/store.mjs';
import { validateTaskDraft } from '../../src/tasks/contract.mjs';
import { replayTask, formatReplayReport } from '../../src/tasks/replay.mjs';

const NOW = () => 1_700_000_000_000;

function withStores(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'lain-replay-'));
  const eventLog = open({ path: join(dir, 'events.db'), producer: 'test', now: NOW });
  const taskStore = openTaskStore({ path: join(dir, 'tasks.db'), now: NOW });
  try {
    return fn({ eventLog, taskStore, dir });
  } finally {
    taskStore.close();
    eventLog.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function makeContract() {
  return validateTaskDraft(
    {
      objective: 'replay deterministic task execution',
      acceptance_criteria: [
        {
          id: 'c1',
          statement: 'output artifact exists',
          check: { kind: 'artifact', path: 'out.txt' },
          required: true,
        },
      ],
      capabilities: ['workspace.write'],
      effect_class: 'local_reversible',
      budget: { max_tool_calls: 2, max_wall_ms: 10_000 },
    },
    { now: NOW },
  );
}

test('AT-M11-01: unknown task returns TASK_NOT_FOUND and invalid taskId is refused', () => {
  withStores(({ eventLog, taskStore }) => {
    const missing = replayTask('01J00000000000000000000000', { eventLog, taskStore });
    assert.deepEqual(missing, {
      ok: false,
      found: false,
      task_id: '01J00000000000000000000000',
      reason: 'TASK_NOT_FOUND',
    });

    assert.throws(() => replayTask('', { eventLog, taskStore }), { code: 'INVALID_TASK_ID' });
    assert.throws(() => replayTask(/** @type {string} */ (/** @type {unknown} */ (null)), { eventLog, taskStore }), {
      code: 'INVALID_TASK_ID',
    });
  });
});

test('AT-M11-02: replayTask reconstructs exact counts, timeline, and ok: true from real stores', () => {
  withStores(({ eventLog, taskStore }) => {
    const created = taskStore.create({ contract: makeContract(), origin: 'test' });
    const taskId = created.task_id;

    taskStore.grantCapabilities(taskId, ['workspace.write'], { granted_by: 'policy' });
    taskStore.transition(taskId, 'admitted', { reason: 'admitted' });
    taskStore.transition(taskId, 'running', { reason: 'started' });
    taskStore.setResult(taskId, {
      claims: [{ claim: 'done', supported_by: 'c1' }],
      artifacts: [{ path: 'out.txt', bytes: 4 }],
      evidence: [{ kind: 'artifact', path: 'out.txt' }],
      checks: [{ id: 'c1', statement: 'output artifact exists', required: true, verdict: 'passed', detail: 'ok' }],
      not_verified: [],
      indeterminate: [],
      decision_ids: ['dec_1'],
      tool: { tool_id: 'write_file', status: 'ok', reason_code: null },
    });
    taskStore.transition(taskId, 'completed', { reason: 'checks_passed', evidence: { requiredChecksPassed: true } });

    eventLog.record('policy.decided', { action: 'task.admit', outcome: 'allow', arm_id: 'A1', reason_code: 'OK' }, { task_id: taskId });
    eventLog.record('model.invoked', { model: 'qwen3-4b', step: 1 }, { task_id: taskId });
    eventLog.record('tool.executed', { tool_id: 'write_file', status: 'ok', exit_code: 0 }, { task_id: taskId });
    eventLog.record('tool.executed', { tool_id: 'run_script', status: 'error', exit_code: 1 }, { task_id: taskId });

    const report = replayTask(taskId, { eventLog, taskStore });
    assert.equal(report.found, true);
    if (!report.found) return;

    assert.equal(report.ok, true);
    assert.equal(report.final_state, 'completed');
    assert.equal(report.task?.task_id, taskId);
    assert.equal(report.verification.ok, true);
    assert.equal(report.history.length, 4);

    assert.deepEqual(report.counts, {
      total_events: 4,
      policy_decisions: 1,
      model_invocations: 1,
      tool_executions: 2,
      tool_failures: 1,
      transitions: 4,
    });

    assert.equal(report.timeline.length, 4);
    assert.deepEqual(
      report.timeline.map((e) => e.event_type),
      ['policy.decided', 'model.invoked', 'tool.executed', 'tool.executed'],
    );
    for (const entry of report.timeline) {
      assert.equal(typeof entry.seq, 'number');
      assert.equal(typeof entry.occurred_at, 'string');
      assert.equal(typeof entry.producer, 'string');
      assert.equal(typeof entry.payload, 'object');
      assert.equal(typeof entry.payload_hash, 'string');
    }
  });
});

test('AT-M11-03: formatReplayReport produces human-readable task, state, events, counts, and timeline lines', () => {
  withStores(({ eventLog, taskStore }) => {
    const missingText = formatReplayReport(replayTask('missing-id', { eventLog, taskStore }));
    assert.match(missingText, /task\s+missing-id/);
    assert.match(missingText, /TASK_NOT_FOUND/);

    const { task_id: taskId } = taskStore.create({ contract: makeContract() });
    eventLog.record('policy.decided', { outcome: 'allow' }, { task_id: taskId });
    eventLog.record('model.invoked', { model: 'qwen3-4b' }, { task_id: taskId });
    eventLog.record('tool.executed', { tool_id: 'run_script', status: 'ok' }, { task_id: taskId });

    const report = replayTask(taskId, { eventLog, taskStore });
    const text = formatReplayReport(report);
    assert.match(text, new RegExp(`task\\s+${taskId}`));
    assert.match(text, /state\s+submitted/);
    assert.match(text, /events\s+3/);
    assert.match(text, /counts\s+policy=1 model=1 tool=1 failures=0 transitions=1/);
    assert.match(text, /timeline:/);
    assert.match(text, /policy\.decided/);
    assert.match(text, /model\.invoked/);
    assert.match(text, /tool\.executed/);
  });
});

test('AT-M11-04: replayTask does not mutate the event log or task store and is deterministic', () => {
  withStores(({ eventLog, taskStore }) => {
    const { task_id: taskId } = taskStore.create({ contract: makeContract() });
    eventLog.record('policy.decided', { outcome: 'allow' }, { task_id: taskId });
    eventLog.record('tool.executed', { tool_id: 'run_script', status: 'ok' }, { task_id: taskId });

    const beforeEvents = eventLog.stats().count;
    const beforeTasks = taskStore.stats().tasks;

    const first = replayTask(taskId, { eventLog, taskStore });
    const second = replayTask(taskId, { eventLog, taskStore });

    assert.equal(eventLog.stats().count, beforeEvents);
    assert.equal(taskStore.stats().tasks, beforeTasks);
    assert.deepEqual(first, second);
  });
});
