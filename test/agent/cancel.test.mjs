import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { open } from '../../src/store/index.mjs';
import { openTaskStore } from '../../src/tasks/store.mjs';
import { validateTaskDraft } from '../../src/tasks/contract.mjs';
import { CANCEL_ACTIONS, CancelError, UNKNOWN_EFFECT_ACTION, classifyCancellation, createCanceller } from '../../src/agent/cancel.mjs';
import { checkTransition, transitionRequirements } from '../../src/tasks/states.mjs';

/**
 * V-2 cancellation tests (AT-V2-CAN-01..04), each with its positive control.
 *
 * What is being proved: the cascade is idempotent, the terminal-intent row exists
 * before anything is signalled, the effect class decides kill-or-escalate, and
 * `cancelled` is refused unless the OS enumeration came back empty. The refusal is
 * the feature: a cancelled task that still ran something is not a success.
 *
 * The job handle is injected here on purpose. The runner seam (runInJob) is the
 * execution layer's contract, and these tests must hold whether or not it exists.
 */

const NOW = () => 1_700_000_000_000;

function draft(overrides = {}) {
  return {
    objective: 'produce health.json for the cancellation tests',
    acceptance_criteria: [
      {
        id: 'c1',
        statement: 'the health check wrote health.json into the workspace',
        check: { kind: 'artifact', path: 'health.json' },
        required: true,
      },
    ],
    capabilities: ['workspace.write', 'process.spawn'],
    effect_class: 'local_reversible',
    budget: { max_tool_calls: 2, max_wall_ms: 30_000 },
    ...overrides,
  };
}

function contract(overrides = {}) {
  return validateTaskDraft(draft(overrides), { now: NOW });
}

/** A task store, an event log and a workspace root, all in one temp directory. */
async function harness(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'lain-cancel-'));
  const store = openTaskStore({ path: join(dir, 'tasks.db'), now: NOW });
  const log = open({ path: join(dir, 'events.db'), producer: 'test' });
  const workspaceRoot = join(dir, 'ws');
  mkdirSync(workspaceRoot, { recursive: true });
  try {
    return await fn({ dir, store, log, workspaceRoot });
  } finally {
    log.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function runningTask(store, overrides = {}) {
  const created = store.create({ contract: contract(overrides), origin: 'test' });
  store.transition(created.task_id, 'admitted', { reason: 'test' });
  store.transition(created.task_id, 'running', { reason: 'test' });
  return created.task_id;
}

/**
 * A stand-in for the job handle the execution layer owns. `pids` are live until
 * something terminates or stops them, which is how the tests control whether the
 * verification step finds survivors.
 */
function fakeJob(options = {}) {
  const { pids = [], terminateClears = true, stopClears = true, withStop = false, onTerminate = null } = options;
  let live = [...pids];
  const calls = { terminate: 0, stop: 0, enumerate: 0 };
  const control = {
    enumerate() {
      calls.enumerate += 1;
      return [...live];
    },
    terminate() {
      calls.terminate += 1;
      if (typeof onTerminate === 'function') onTerminate();
      if (terminateClears) live = [];
    },
  };
  if (withStop) {
    control.requestStop = () => {
      calls.stop += 1;
      if (stopClears) live = [];
    };
  }
  return { control, calls };
}

function canceller(ctx, overrides = {}) {
  return createCanceller({
    taskStore: ctx.store,
    openLog: () => ctx.log,
    now: NOW,
    workspaceRoot: ctx.workspaceRoot,
    ...overrides,
  });
}

function hasCode(code) {
  return (err) => {
    assert.equal(err.code, code, `expected code ${code}, got ${String(err.code)}: ${err.message}`);
    return true;
  };
}

// ---------------------------------------------------------------------------
// AT-V2-CAN-01 — one request, however many times it is asked for
// ---------------------------------------------------------------------------

test('AT-V2-CAN-01: a second requestCancellation returns the first request', async () => {
  await harness(async (ctx) => {
    const taskId = runningTask(ctx.store);
    const job = fakeJob();
    const cancel = canceller(ctx, { jobControl: () => job.control });

    const first = await cancel.requestCancellation(taskId, { reason: 'test asked first', requested_by: 'tester' });
    const second = await cancel.requestCancellation(taskId, { reason: 'someone else asked later', requested_by: 'intruder' });

    assert.equal(second.request_id, first.request_id, 'the same request id comes back');
    assert.equal(second.replayed, true, 'and it is marked as a replay, not a new request');
    assert.equal(second.requested_by, 'tester', 'the first asker is the recorded one');
    assert.equal(second.reason, 'test asked first', 'the second reason does not overwrite the first');
    assert.equal(ctx.log.read({ task_id: taskId, event_type: 'task.cancel.requested' }).length, 1, 'exactly one request row');
    assert.equal(job.calls.terminate, 1, 'the second call did not kill a second time');
  });
});

test('AT-V2-CAN-01b (positive control): the first call creates exactly one request, with its id on the row', async () => {
  await harness(async (ctx) => {
    const taskId = runningTask(ctx.store);
    assert.equal(ctx.log.read({ task_id: taskId }).length, 0, 'the task starts with no events at all');

    const cancel = canceller(ctx, { jobControl: () => fakeJob().control });
    const first = await cancel.requestCancellation(taskId, { reason: 'test', requested_by: 'tester' });

    assert.equal(typeof first.request_id, 'string');
    assert.ok(first.request_id.length > 0, 'the request has an id');
    const rows = ctx.log.read({ task_id: taskId, event_type: 'task.cancel.requested' });
    assert.equal(rows.length, 1, 'one call, one row');
    assert.equal(rows[0].payload.request_id, first.request_id, 'the row carries the id it created');
    assert.equal(rows[0].payload.requested_by, 'tester', 'and the name of whoever asked');
  });
});

test('AT-V2-CAN-01c: two concurrent calls join one cancellation instead of racing', async () => {
  await harness(async (ctx) => {
    const taskId = runningTask(ctx.store);
    const job = fakeJob();
    const cancel = canceller(ctx, { jobControl: () => job.control });

    const [a, b] = await Promise.all([
      cancel.requestCancellation(taskId, { reason: 'first', requested_by: 'tester' }),
      cancel.requestCancellation(taskId, { reason: 'second', requested_by: 'other' }),
    ]);

    assert.equal(a.request_id, b.request_id, 'both callers get the one request');
    assert.equal(ctx.log.read({ task_id: taskId, event_type: 'task.cancel.requested' }).length, 1);
    assert.equal(job.calls.terminate, 1, 'the job was terminated once, not twice');
  });
});

test('AT-V2-CAN-01d: idempotency survives a restart, because it is read from the log', async () => {
  await harness(async (ctx) => {
    const taskId = runningTask(ctx.store);
    const first = await canceller(ctx, { jobControl: () => fakeJob().control }).requestCancellation(taskId, {
      reason: 'test',
      requested_by: 'tester',
    });

    // A fresh canceller has no in-process memory of the first call. If the answer
    // still comes back, it came from the durable row.
    const afterRestart = await canceller(ctx, { jobControl: () => fakeJob().control }).requestCancellation(taskId, {
      reason: 'test',
      requested_by: 'tester',
    });

    assert.equal(afterRestart.request_id, first.request_id);
    assert.equal(afterRestart.replayed, true);
    assert.equal(ctx.log.read({ task_id: taskId, event_type: 'task.cancel.requested' }).length, 1);
  });
});

// ---------------------------------------------------------------------------
// AT-V2-CAN-02 — the intent is on record before anything dies
// ---------------------------------------------------------------------------

test('AT-V2-CAN-02: the terminal intent row precedes the kill', async () => {
  await harness(async (ctx) => {
    const taskId = runningTask(ctx.store);
    const atKill = [];
    const job = fakeJob({
      pids: [111, 222],
      onTerminate: () => {
        const history = ctx.store.history(taskId);
        atKill.push({ state: ctx.store.get(taskId).state, newest: history[history.length - 1]?.to });
      },
    });
    const cancel = canceller(ctx, { jobControl: () => job.control });
    const request = await cancel.requestCancellation(taskId, { reason: 'test', requested_by: 'tester' });

    assert.equal(job.calls.terminate, 1, 'the kill happened, so there was something to order');
    assert.equal(atKill.length, 1, 'the kill read the store at the moment it ran');
    assert.equal(atKill[0].state, 'cancelling', 'the task was already cancelling when the kill ran');
    assert.equal(atKill[0].newest, 'cancelling', 'the newest history row is the intent row');
    assert.equal(request.status, 'cancelled');
  });
});

test('AT-V2-CAN-02b (positive control): the intent row exists after a cancellation that kills', async () => {
  await harness(async (ctx) => {
    const taskId = runningTask(ctx.store);
    const job = fakeJob({ pids: [111] });
    await canceller(ctx, { jobControl: () => job.control }).requestCancellation(taskId, {
      reason: 'test',
      requested_by: 'tester',
    });

    assert.equal(job.calls.terminate, 1);
    const history = ctx.store.history(taskId);
    const toCancelling = history.findIndex((row) => row.to === 'cancelling');
    const toCancelled = history.findIndex((row) => row.to === 'cancelled');
    assert.ok(toCancelling >= 0, 'running -> cancelling is in the history');
    assert.equal(history[toCancelling].from, 'running');
    assert.ok(toCancelled > toCancelling, 'cancelling -> cancelled is a later row');
  });
});

test('AT-V2-CAN-02c: a cancellation that does not name who asked is refused and changes nothing', async () => {
  await harness(async (ctx) => {
    const taskId = runningTask(ctx.store);
    const cancel = canceller(ctx, { jobControl: () => fakeJob({ pids: [7] }).control });

    await assert.rejects(() => cancel.requestCancellation(taskId, { reason: 'no name' }), hasCode('REQUESTED_BY_REQUIRED'));
    assert.equal(ctx.store.get(taskId).state, 'running', 'the task is untouched');
    assert.equal(ctx.log.read({ task_id: taskId }).length, 0, 'and nothing was written about it');
  });
});

test('AT-V2-CAN-02d: cancelling is a legal edge from running, and a second cancel cannot re-enter it', async () => {
  await harness(async (ctx) => {
    const taskId = runningTask(ctx.store);
    const cancel = canceller(ctx, { jobControl: () => fakeJob().control });
    await cancel.requestCancellation(taskId, { reason: 'test', requested_by: 'tester' });

    const rows = ctx.store.history(taskId).filter((row) => row.to === 'cancelling');
    assert.equal(rows.length, 1, 'the terminal intent is entered once');
    assert.equal(ctx.store.get(taskId).state, 'cancelled', 'and the task then settles');
  });
});

// ---------------------------------------------------------------------------
// AT-V2-CAN-03 — the effect class decides, and unknown means a human
// ---------------------------------------------------------------------------

test('AT-V2-CAN-03: an unknown effect class escalates to a human and never kills', async () => {
  await harness(async (ctx) => {
    const taskId = runningTask(ctx.store, { effect_class: 'delete_the_universe' });
    const job = fakeJob({ pids: [111, 222] });
    const delivered = [];
    const cancel = canceller(ctx, { jobControl: () => job.control, escalate: (r) => delivered.push(r) });
    const request = await cancel.requestCancellation(taskId, { reason: 'test', requested_by: 'tester' });

    assert.equal(job.calls.terminate, 0, 'nothing was killed');
    assert.equal(request.kill_attempted, false);
    assert.equal(request.status, 'escalated');
    assert.equal(request.escalated, true);
    assert.equal(request.effect_class, 'external', 'an unrecognised class fails towards caution');
    assert.equal(request.class_known, false, 'and it is still visibly unknown');
    assert.equal(request.state, 'cancel_failed', 'an escalation is not a cancellation');
    assert.equal(ctx.store.get(taskId).state, 'cancel_failed');
    assert.ok(request.human_action_required, 'a human is told what is wanted');
    assert.equal(delivered.length, 1, 'the escalation was delivered');
    assert.equal(ctx.log.read({ task_id: taskId, event_type: 'task.cancel.escalated' }).length, 1);
  });
});

test('AT-V2-CAN-03b (positive control): a local_reversible task is killed', async () => {
  await harness(async (ctx) => {
    const taskId = runningTask(ctx.store, { effect_class: 'local_reversible' });
    const job = fakeJob({ pids: [4242] });
    const cancel = canceller(ctx, { jobControl: () => job.control });
    const request = await cancel.requestCancellation(taskId, { reason: 'test', requested_by: 'tester' });

    assert.equal(job.calls.terminate, 1, 'the job was terminated');
    assert.equal(request.kill_attempted, true);
    assert.equal(request.action, 'kill_then_record_writes');
    assert.equal(request.effect_class, 'local_reversible');
    assert.equal(request.status, 'cancelled');
  });
});

test('AT-V2-CAN-03c: external and local_irreversible both escalate rather than kill', async () => {
  await harness(async (ctx) => {
    for (const effectClass of ['external', 'local_irreversible']) {
      const taskId = runningTask(ctx.store, { effect_class: effectClass });
      const job = fakeJob({ pids: [5] });
      const cancel = canceller(ctx, { jobControl: () => job.control });
      const request = await cancel.requestCancellation(taskId, { reason: 'test', requested_by: 'tester' });

      assert.equal(job.calls.terminate, 0, `${effectClass} was not killed`);
      assert.equal(request.status, 'escalated', `${effectClass} escalated`);
      assert.equal(ctx.store.get(taskId).state, 'cancel_failed');
    }
  });
});

test('AT-V2-CAN-03d: read_only stops at a safe point instead of killing the tree', async () => {
  await harness(async (ctx) => {
    const taskId = runningTask(ctx.store, { effect_class: 'read_only' });
    const job = fakeJob({ pids: [77], withStop: true });
    const cancel = canceller(ctx, { jobControl: () => job.control });
    const request = await cancel.requestCancellation(taskId, { reason: 'test', requested_by: 'tester' });

    assert.equal(job.calls.terminate, 0, 'a read-only task is never killed');
    assert.equal(job.calls.stop, 1, 'it is asked to stop at the next safe point');
    assert.equal(request.kill_attempted, false);
    assert.equal(request.stop_requested, true);
    assert.equal(request.status, 'cancelled', 'and zero survivors still has to be verified');
  });
});

test('AT-V2-CAN-03e: the class table is the frozen contract, and anything unrecognised escalates', () => {
  assert.deepEqual(CANCEL_ACTIONS, {
    read_only: 'stop_at_safe_point',
    local_reversible: 'kill_then_record_writes',
    local_transactional: 'kill_then_mark_unusable',
    external: 'escalate_no_kill',
    local_irreversible: 'escalate_no_kill',
  });
  assert.equal(classifyCancellation({ effect_class: 'read_only' }).kills, false);
  assert.equal(classifyCancellation({ effect_class: 'local_transactional' }).kills, true);
  assert.equal(classifyCancellation({}).action, UNKNOWN_EFFECT_ACTION);
  assert.equal(classifyCancellation({ effect_class: 'nonsense' }).action, UNKNOWN_EFFECT_ACTION);
  assert.equal(classifyCancellation({ effect_class: 'read_only', effect_class_known: false }).action, UNKNOWN_EFFECT_ACTION);
});

// ---------------------------------------------------------------------------
// AT-V2-CAN-04 — `cancelled` needs a verified zero, or it is a refusal
// ---------------------------------------------------------------------------

test('AT-V2-CAN-04: `cancelled` is refused with survivors, and `cancel_failed` carries the count', async () => {
  await harness(async (ctx) => {
    const taskId = runningTask(ctx.store);
    const job = fakeJob({ pids: [111, 222], terminateClears: false });
    const cancel = canceller(ctx, { jobControl: () => job.control });
    const request = await cancel.requestCancellation(taskId, { reason: 'test', requested_by: 'tester' });

    assert.equal(request.survivors, 2, 'the count is the point');
    assert.deepEqual(request.survivor_pids, [111, 222], 'and it names them');
    assert.equal(request.survivors_verified_by, 'os_enumeration');
    assert.equal(request.status, 'cancel_failed');
    assert.notEqual(request.status, 'cancelled');
    assert.equal(request.state, 'cancel_failed');
    assert.equal(ctx.store.get(taskId).state, 'cancel_failed', 'the store settled on the refusal');
    const newest = ctx.store.history(taskId).at(-1);
    assert.equal(newest?.to, 'cancel_failed');
    assert.equal(newest?.evidence.survivingProcesses, 2, 'the survivor count is in the transition evidence');
    assert.equal(request.result_recorded, true, 'and the result records the failure');
  });
});

test('AT-V2-CAN-04b (positive control): zero survivors reaches `cancelled`', async () => {
  await harness(async (ctx) => {
    const taskId = runningTask(ctx.store);
    const job = fakeJob({ pids: [111, 222] });
    const cancel = canceller(ctx, { jobControl: () => job.control });
    const request = await cancel.requestCancellation(taskId, { reason: 'test', requested_by: 'tester' });

    assert.equal(job.calls.terminate, 1);
    assert.equal(request.survivors, 0);
    assert.deepEqual(request.survivor_pids, []);
    assert.equal(request.survivors_verified_by, 'os_enumeration', 'zero was checked against the OS, not assumed');
    assert.equal(request.status, 'cancelled');
    assert.equal(request.state, 'cancelled');
    assert.equal(ctx.store.get(taskId).state, 'cancelled');
    const newest = ctx.store.history(taskId).at(-1);
    assert.equal(newest?.to, 'cancelled');
    assert.equal(newest?.evidence.survivingProcesses, 0);
  });
});

test('AT-V2-CAN-04c: an enumeration that failed cannot be rounded down to zero', async () => {
  await harness(async (ctx) => {
    const taskId = runningTask(ctx.store);
    const control = {
      enumerate() {
        throw new Error('the OS query failed');
      },
      terminate() {},
    };
    const cancel = canceller(ctx, { jobControl: () => control });
    const request = await cancel.requestCancellation(taskId, { reason: 'test', requested_by: 'tester' });

    assert.equal(request.survivors, null, 'not known is not the same answer as zero');
    assert.equal(request.survivors_verified_by, 'enumeration_failed');
    assert.equal(request.status, 'cancel_failed');
    assert.equal(ctx.store.get(taskId).state, 'cancel_failed');
  });
});

test('AT-V2-CAN-04d: a job handle that cannot be resolved is also not a verified zero', async () => {
  await harness(async (ctx) => {
    const taskId = runningTask(ctx.store);
    const cancel = canceller(ctx, {
      jobControl: () => {
        throw new Error('the job registry is unavailable');
      },
    });
    const request = await cancel.requestCancellation(taskId, { reason: 'test', requested_by: 'tester' });

    assert.equal(request.survivors, null);
    assert.equal(request.survivors_verified_by, 'job_lookup_failed');
    assert.equal(request.status, 'cancel_failed');
  });
});

test('AT-V2-CAN-04e: a task with no registered job verifies zero by absence, not by guessing', async () => {
  await harness(async (ctx) => {
    const taskId = runningTask(ctx.store);
    const cancel = canceller(ctx, { jobControl: () => null });
    const request = await cancel.requestCancellation(taskId, { reason: 'test', requested_by: 'tester' });

    assert.equal(request.survivors, 0);
    assert.equal(request.survivors_verified_by, 'no_job_registered');
    assert.equal(request.kill_attempted, false, 'there was nothing to kill');
    assert.equal(request.status, 'cancelled');
    assert.equal(ctx.store.get(taskId).state, 'cancelled');
  });
});

test('AT-V2-CAN-04f: a deadline that passes is never a successful cancellation', async () => {
  await harness(async (ctx) => {
    const taskId = runningTask(ctx.store);
    let terminated = 0;
    const control = {
      enumerate: () => [1313],
      terminate() {
        terminated += 1;
        return new Promise(() => {});
      },
    };
    const cancel = canceller(ctx, { jobControl: () => control });
    const request = await cancel.requestCancellation(taskId, { reason: 'test', requested_by: 'tester', deadline_ms: 5 });

    assert.equal(terminated, 1, 'the kill was attempted and did not come back');
    assert.equal(request.deadline_exceeded, true);
    assert.notEqual(request.status, 'cancelled');
    assert.equal(request.state, 'cancel_failed');
    assert.equal(ctx.store.get(taskId).state, 'cancel_failed');
    assert.equal(ctx.log.read({ task_id: taskId, event_type: 'task.cancel.escalated' }).length, 1, 'a human is told');
  });
});

// ---------------------------------------------------------------------------
// Per-class bookkeeping: what the cascade leaves behind for a human to read
// ---------------------------------------------------------------------------

test('local_reversible records what was written and leaves the bytes where they are', async () => {
  await harness(async (ctx) => {
    const taskId = runningTask(ctx.store, { effect_class: 'local_reversible' });
    const dir = join(ctx.workspaceRoot, taskId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'health.json'), '{"ok":true}');

    const cancel = canceller(ctx, { jobControl: () => fakeJob({ pids: [9] }).control });
    const request = await cancel.requestCancellation(taskId, { reason: 'test', requested_by: 'tester' });

    assert.equal(existsSync(join(dir, 'health.json')), true, 'a reversible write is not hidden');
    assert.equal(request.writes?.recorded, true);
    assert.deepEqual(request.writes?.files, [{ path: 'health.json', bytes: 11 }]);
    assert.equal(request.quarantined, null);
  });
});

test('local_transactional marks the partial write unusable and does not delete it', async () => {
  await harness(async (ctx) => {
    const taskId = runningTask(ctx.store, { effect_class: 'local_transactional' });
    const dir = join(ctx.workspaceRoot, taskId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'health.json'), '{"ok":');
    const before = readFileSync(join(dir, 'health.json'));

    const cancel = canceller(ctx, { jobControl: () => fakeJob({ pids: [9] }).control });
    const request = await cancel.requestCancellation(taskId, { reason: 'test', requested_by: 'tester' });

    const marked = join(dir, 'health.json.partial-unusable');
    assert.equal(existsSync(join(dir, 'health.json')), false, 'the expected name no longer resolves to a half-written file');
    assert.equal(existsSync(marked), true, 'the bytes survive under a name that says what they are');
    assert.deepEqual(readFileSync(marked), before, 'nothing was deleted');
    assert.deepEqual(request.quarantined?.renamed, [{ from: 'health.json', to: 'health.json.partial-unusable' }]);
    assert.equal(request.status, 'cancelled', 'the partial write was settled, so the task itself stopped');
  });
});

// ---------------------------------------------------------------------------
// The two edges that are not `running`. A task nobody can stop is not a task
// that is safe to start, so both are reachable, and both end in the log.
// ---------------------------------------------------------------------------

test('a task that was never admitted can be stopped, and the record says nothing had begun', async () => {
  await harness(async (ctx) => {
    const created = ctx.store.create({ contract: contract(), origin: 'test' });
    const cancel = canceller(ctx, { jobControl: () => null });
    const request = await cancel.requestCancellation(created.task_id, {
      reason: 'stopped before it started',
      requested_by: 'tester',
    });

    assert.equal(request.status, 'cancelled');
    assert.equal(request.survivors, 0);
    assert.equal(request.survivors_verified_by, 'never_started', 'zero because nothing began, not because a kill worked');
    assert.equal(request.kill_attempted, false, 'there was nothing to kill');
    assert.equal(request.escalated, false, 'a task with no effect in flight is not a question for a human');
    assert.equal(ctx.store.get(created.task_id).state, 'cancelled', 'terminal, and recorded');
    const reached = ctx.store.history(created.task_id).map((row) => row.to);
    assert.deepEqual(reached.slice(-2), ['cancelling', 'cancelled'], 'the intent row precedes the settle');
    assert.ok(!reached.includes('admitted') && !reached.includes('running'), 'it was stopped before it ever ran');
    assert.equal(ctx.log.read({ task_id: created.task_id, event_type: 'task.cancel.refused' }).length, 0);
    assert.equal(ctx.log.read({ task_id: created.task_id, event_type: 'task.cancel.before_effect' }).length, 1);
    assert.equal(ctx.log.read({ task_id: created.task_id, event_type: 'task.cancel.requested' }).length, 1);
  });
});

test('a `submitted` task that owns a job handle is enumerated, not assumed empty', async () => {
  await harness(async (ctx) => {
    const created = ctx.store.create({ contract: contract(), origin: 'test' });
    const job = fakeJob({ pids: [7], terminateClears: false });
    const cancel = canceller(ctx, { jobControl: () => job.control });
    const request = await cancel.requestCancellation(created.task_id, { reason: 'test', requested_by: 'tester' });

    assert.equal(request.survivors_verified_by, 'os_enumeration', 'a handle that exists is a fact, and facts outrank inferences');
    assert.equal(job.calls.enumerate, 1, 'the handle was asked');
    assert.equal(request.kill_attempted, true, 'a local_reversible task with a live job is killed whatever state it was in');
    assert.equal(request.survivors, 1);
    assert.equal(request.status, 'cancel_failed', 'a live process is never reported as a clean stop');
  });
});

test('an `indeterminate` task can be stopped, and a lost handle is never rounded to zero', async () => {
  await harness(async (ctx) => {
    const taskId = runningTask(ctx.store);
    ctx.store.transition(taskId, 'indeterminate', { reason: 'the runner lost the handle' });
    const seen = [];
    const cancel = canceller(ctx, { jobControl: () => null, escalate: (r) => seen.push(r) });
    const request = await cancel.requestCancellation(taskId, { reason: 'stop it', requested_by: 'tester' });

    assert.equal(request.survivors, null, 'no handle means the count is unknown, not zero');
    assert.equal(request.survivors_verified_by, 'job_handle_missing');
    assert.equal(request.status, 'escalated', 'a possibly-live process with no handle is a human decision');
    assert.equal(request.state, 'cancel_failed', 'terminal, and honest about what was not proved');
    assert.equal(seen.length, 1, 'and the human is actually told');
    const escalated = ctx.log.read({ task_id: taskId, event_type: 'task.cancel.escalated' });
    assert.equal(escalated.length, 1);
    const payload = /** @type {{reason_code?: string}} */ (/** @type {Record<string, unknown>} */ (escalated[0]).payload);
    assert.equal(payload.reason_code, 'SURVIVORS_UNVERIFIABLE');
    const settle = ctx.store.history(taskId).filter((row) => row.to === 'cancel_failed');
    assert.equal(settle.length, 1);
    assert.equal(settle[0]?.evidence?.survivingProcesses, null, 'the count is recorded as unknown, never as 0');
  });
});

test('an `indeterminate` task whose job enumerates empty does reach `cancelled`', async () => {
  await harness(async (ctx) => {
    const taskId = runningTask(ctx.store);
    ctx.store.transition(taskId, 'indeterminate', { reason: 'the runner lost the handle, then found it again' });
    const job = fakeJob({ pids: [] });
    const cancel = canceller(ctx, { jobControl: () => job.control });
    const request = await cancel.requestCancellation(taskId, { reason: 'stop it', requested_by: 'tester' });

    assert.equal(request.survivors_verified_by, 'os_enumeration');
    assert.equal(request.survivors, 0);
    assert.equal(request.status, 'cancelled', 'a verified zero is still a verified zero, whatever the state was');
    assert.equal(ctx.store.get(taskId).state, 'cancelled');
  });
});

test('the two edges exist in the machine itself, and `cancelled` still demands a verified zero', () => {
  assert.deepEqual(checkTransition('submitted', 'cancelling'), { legal: true, code: 'OK' });
  assert.deepEqual(checkTransition('indeterminate', 'cancelling'), { legal: true, code: 'OK' });
  assert.equal(checkTransition('cancelled', 'cancelling').code, 'TERMINAL_IS_TERMINAL');
  assert.equal(checkTransition('cancel_failed', 'cancelling').code, 'TERMINAL_IS_TERMINAL');
  assert.deepEqual(transitionRequirements('cancelled', { survivingProcesses: 0 }), []);
  assert.deepEqual(transitionRequirements('cancelled', { survivingProcesses: null }), ['zero_surviving_processes']);
});

test('the terminal four stay terminal: a settled task is not moved and not killed again', async () => {
  await harness(async (ctx) => {
    const taskId = runningTask(ctx.store);
    const job = fakeJob();
    const cancel = canceller(ctx, { jobControl: () => job.control });
    await cancel.requestCancellation(taskId, { reason: 'test', requested_by: 'tester' });
    const before = ctx.store.history(taskId).length;
    const second = await cancel.requestCancellation(taskId, { reason: 'test', requested_by: 'tester' });

    assert.equal(second.status, 'cancelled', 'a second cancel reports where the task ended up');
    assert.equal(ctx.store.get(taskId).state, 'cancelled', 'and the machine did not move');
    assert.equal(ctx.store.history(taskId).length, before, 'no second settle was written');
    assert.equal(job.calls.terminate, 1, 'nothing was killed twice');
    assert.equal(ctx.log.read({ task_id: taskId, event_type: 'task.cancel.ignored' }).length, 1);
    assert.equal(ctx.log.read({ task_id: taskId, event_type: 'task.cancel.requested' }).length, 1, 'still one request');
  });
});

test('the cascade records who asked, and never reports success without the verification that allows it', async () => {
  await harness(async (ctx) => {
    const taskId = runningTask(ctx.store);
    const seen = [];
    const cancel = canceller(ctx, { jobControl: () => fakeJob().control, escalate: (r) => seen.push(r) });
    const request = await cancel.requestCancellation(taskId, {
      reason: 'the owner asked',
      reason_code: 'OWNER_STOP',
      requested_by: 'owner',
    });

    assert.equal(request.requested_by, 'owner');
    assert.equal(request.reason, 'the owner asked');
    assert.equal(request.reason_code, 'OWNER_STOP');
    assert.equal(request.status, 'cancelled');
    assert.equal(seen.length, 0, 'a cancellation that verified zero survivors is not an escalation');
    const intent = ctx.store.history(taskId).find((row) => row.to === 'cancelling');
    assert.match(String(intent?.reason), /owner/, 'the intent row names who asked');
    assert.match(String(intent?.reason), /OWNER_STOP/, 'and under which reason code');
  });
});

test('a cancellation that already finished is recorded as ignored rather than re-run', async () => {
  await harness(async (ctx) => {
    const taskId = runningTask(ctx.store);
    const cancel = canceller(ctx, { jobControl: () => fakeJob().control });
    await cancel.requestCancellation(taskId, { reason: 'test', requested_by: 'tester' });
    const second = await cancel.requestCancellation(taskId, { reason: 'test', requested_by: 'tester' });

    assert.equal(ctx.log.read({ task_id: taskId, event_type: 'task.cancel.ignored' }).length, 1);
    assert.equal(second.status, 'cancelled', 'the answer still reflects the outcome that happened');
  });
});

test('CancelError is an Error subclass so a caller can catch it by type', () => {
  const err = new CancelError('SOMETHING', 'a detail');
  assert.ok(err instanceof Error);
  assert.equal(err.code, 'SOMETHING');
  assert.match(err.message, /a detail/);
});
