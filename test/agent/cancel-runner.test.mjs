import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { open } from '../../src/store/index.mjs';
import { openTaskStore } from '../../src/tasks/store.mjs';
import { validateTaskDraft } from '../../src/tasks/contract.mjs';
import { DEFAULT_RULES } from '../../src/policy/rules.mjs';
import { createRegistry } from '../../src/tools/registry.mjs';
import { createTaskRunner } from '../../src/agent/task-runner.mjs';

/**
 * The runner seam: what happens to a task that is already running when someone
 * asks it to stop.
 *
 * The tool here is injected and asynchronous on purpose. The real `run_script`
 * drives `workspace.run`, which is a `spawnSync` call and therefore holds the
 * event loop, so an in-process timer cannot fire while it runs; wiring the real
 * job (`runInJob`) is the execution layer's job and the runner half must hold
 * before it lands. What is being proved: bounded time, and no `completed` written
 * over a task a cascade has taken over.
 *
 * The stand-in job is faithful in the one way that matters — terminating it makes
 * the tool return, which is what killing a real job does.
 */

const NOW = () => 1_700_000_000_000;

function draft(overrides = {}) {
  return {
    objective: 'produce health.json while someone asks the task to stop',
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

function contractOf(overrides = {}) {
  return validateTaskDraft(draft(overrides), { now: NOW });
}

/** A task store, an event log and a workspace root, all in one temp directory. */
async function harness(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'lain-cancel-run-'));
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

/** The CLI's own wiring, with the tool and the job handle replaced. */
function makeRunner(ctx, options = {}) {
  return createTaskRunner({
    taskStore: ctx.store,
    openLog: () => ctx.log,
    registry: createRegistry({ rules: DEFAULT_RULES }),
    rules: DEFAULT_RULES,
    workspaceRoot: ctx.workspaceRoot,
    makeTool: options.makeTool,
    approvals: {},
    now: NOW,
    jobControl: options.jobControl,
    deadlineMs: options.deadlineMs,
    escalate: options.escalate,
  });
}

/**
 * A tool that starts, parks until it is released, and only then writes the
 * artifact the acceptance criterion waits for. Nothing about it is interruptible
 * from the inside: the only way the run ends is the runner.
 */
function parkedTool(workspace, gate) {
  return {
    tool_id: 'run_script',
    summary: 'park until released, then write the artifact',
    requires: ['workspace.write', 'process.spawn'],
    effect_class: 'local_reversible',
    spawns_processes: true,
    async run() {
      gate.started = true;
      await gate.released;
      workspace.write('health.json', '{"ok":true}');
      return {
        status: 'ok',
        exit_code: 0,
        stdout: '',
        stderr: '',
        artifacts: [{ path: 'health.json', bytes: 11 }],
      };
    },
  };
}

function gate() {
  /** @type {() => void} */
  let release = () => {};
  const released = new Promise((resolve) => {
    release = () => resolve(undefined);
  });
  return { started: false, released, release };
}

/**
 * A job handle whose live set the test controls. `clears` decides whether the
 * termination actually killed anything, which is how the survivor count is
 * steered.
 */
function jobs(live, options = {}) {
  const { clears = true, onTerminate = () => {} } = options;
  const state = { live: [...live], terminated: 0 };
  const control = {
    enumerate: () => state.live.slice(),
    terminate: () => {
      state.terminated += 1;
      if (clears) state.live = [];
      onTerminate();
    },
  };
  return { state, control };
}

/** Wait until a task exists, so the test can address the run it just started. */
async function taskIdOf(store, limitMs = 2000) {
  const deadline = Date.now() + limitMs;
  for (;;) {
    const rows = store.list();
    if (rows.length > 0) return rows[rows.length - 1].task_id;
    if (Date.now() > deadline) throw new Error(`no task was created within ${limitMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('AT-V2-CAN-02/04 (acceptance): a cancel mid-run reaches `cancelled` in bounded time', { timeout: 15_000 }, async () => {
  await harness(async (ctx) => {
    const g = gate();
    const job = jobs([4242], { onTerminate: () => g.release() });
    const runner = makeRunner(ctx, {
      makeTool: (workspace) => parkedTool(workspace, g),
      jobControl: () => job.control,
    });

    const started = Date.now();
    const outcome = await runner.run({
      contract: contractOf(),
      tool_id: 'run_script',
      tool_arguments: {},
      cancel_after_ms: 20,
    });
    const elapsed = Date.now() - started;

    assert.equal(outcome.state, 'cancelled');
    assert.equal(ctx.store.get(outcome.task_id).state, 'cancelled');
    assert.equal(job.state.terminated, 1, 'the job tree is terminated exactly once');
    assert.equal(outcome.result, null, 'no result is written by the run for a task that was stopped');
    assert.ok(elapsed < 10_000, 'the run ends in bounded time, not when the tool feels like it');

    const abandoned = ctx.log.read({ task_id: outcome.task_id, event_type: 'task.run.abandoned' });
    assert.equal(abandoned.length, 1);
    // Which of the two abandonment points catches it is a race between the kill
    // landing and the tool returning; both mean the same thing, and neither one
    // is a completed task.
    assert.ok(
      ['CANCEL_AFTER_ELAPSED', 'CANCELLED_UNDER_RUN'].includes(abandoned[0].payload.reason_code),
      `unexpected abandonment reason ${abandoned[0].payload.reason_code}`,
    );
    const kinds = ctx.log.read({ task_id: outcome.task_id }).map((row) => row.event_type);
    assert.ok(kinds.indexOf('task.cancel.requested') < kinds.indexOf('task.cancelled'));
    assert.equal(ctx.store.verify(outcome.task_id).ok, true);
  });
});

test('AT-V2-CAN-04 (acceptance): a tool that ignores the cancellation cannot be reported as success', { timeout: 15_000 }, async () => {
  await harness(async (ctx) => {
    const g = gate();
    // The kill does not stick: one process is still alive when it is asked.
    const job = jobs([4242], { clears: false });
    const runner = makeRunner(ctx, {
      makeTool: (workspace) => parkedTool(workspace, g),
      jobControl: () => job.control,
    });

    const outcome = await runner.run({
      contract: contractOf(),
      tool_id: 'run_script',
      tool_arguments: {},
      cancel_after_ms: 20,
    });

    assert.equal(outcome.state, 'cancel_failed');
    const record = ctx.store.get(outcome.task_id);
    assert.equal(record.state, 'cancel_failed');
    const settle = ctx.store.history(outcome.task_id).find((row) => row.to === 'cancel_failed');
    assert.equal(settle.evidence.survivingProcesses, 1, 'the survivor count is in the evidence');
    // The stored result is the cancellation's own account, not a claim about the
    // tool: a task with a live process left behind has nothing to claim.
    assert.equal(record.result.tool.tool_id, 'cancellation');
    assert.deepEqual(record.result.claims, []);
    assert.equal(existsSync(join(ctx.workspaceRoot, outcome.task_id, 'health.json')), false);
    assert.equal(ctx.store.verify(outcome.task_id).ok, true);
  });
});

test('the runner does not write `completed` over a task a cascade has taken over', { timeout: 15_000 }, async () => {
  await harness(async (ctx) => {
    const g = gate();
    const job = jobs([4242], { onTerminate: () => g.release() });
    const runner = makeRunner(ctx, {
      makeTool: (workspace) => parkedTool(workspace, g),
      jobControl: () => job.control,
    });

    const running = runner.run({ contract: contractOf(), tool_id: 'run_script', tool_arguments: {} });
    const taskId = await taskIdOf(ctx.store);
    const request = await runner.cancel(taskId, { reason: 'the operator changed their mind', requested_by: 'test' });
    assert.equal(request.status, 'cancelled');
    assert.equal(ctx.store.get(taskId).state, 'cancelled');

    // The kill makes the tool return, the way killing a real job does — and the
    // tool then finishes its work anyway.
    const outcome = await running;

    assert.equal(outcome.state, 'cancelled', 'the cascade wins over the tool that finished later');
    assert.equal(outcome.result, null);
    assert.equal(ctx.store.get(taskId).state, 'cancelled');
    const states = ctx.store.history(taskId).map((row) => row.to);
    assert.ok(!states.includes('completed'), 'a cancelled task is never also completed');
    const abandoned = ctx.log.read({ task_id: taskId, event_type: 'task.run.abandoned' });
    assert.equal(abandoned.length, 1);
    assert.equal(abandoned[0].payload.reason_code, 'CANCELLED_UNDER_RUN');
  });
});

test('V-1 is not regressed: a run nobody cancels still completes', { timeout: 15_000 }, async () => {
  await harness(async (ctx) => {
    const g = gate();
    g.release();
    const job = jobs([]);
    const runner = makeRunner(ctx, {
      makeTool: (workspace) => parkedTool(workspace, g),
      jobControl: () => job.control,
    });

    const outcome = await runner.run({ contract: contractOf(), tool_id: 'run_script', tool_arguments: {} });

    assert.equal(outcome.state, 'completed');
    assert.equal(ctx.store.get(outcome.task_id).state, 'completed');
    assert.equal(job.state.terminated, 0, 'a completed task terminates nothing');
    assert.ok(outcome.result);
    assert.equal(outcome.result.checks[0].verdict, 'passed');
    assert.equal(ctx.store.verify(outcome.task_id).ok, true);
  });
});

test('an effect class nobody can classify never reaches a kill: it is refused at admission', { timeout: 15_000 }, async () => {
  await harness(async (ctx) => {
    const g = gate();
    const job = jobs([4242]);
    const runner = makeRunner(ctx, {
      makeTool: (workspace) => parkedTool(workspace, g),
      jobControl: () => job.control,
    });

    // The draft's class is not one of the declared five, so it normalises to
    // `external` and the admission arm demands a human before anything runs.
    const outcome = await runner.run({
      contract: contractOf({ effect_class: 'delete_the_universe' }),
      tool_id: 'run_script',
      tool_arguments: {},
      cancel_after_ms: 20,
    });

    assert.equal(outcome.state, 'failed');
    assert.equal(job.state.terminated, 0, 'nothing is terminated for a task that never started');
    assert.equal(g.started, false, 'the tool never ran');
    const failed = ctx.log.read({ task_id: outcome.task_id, event_type: 'task.failed' });
    assert.equal(failed[0].payload.reason_code, 'EFFECT_CLASS_REQUIRES_APPROVAL');
  });
});

test('the runner exposes the cascade, and asking twice is still one request', { timeout: 15_000 }, async () => {
  await harness(async (ctx) => {
    const g = gate();
    const job = jobs([4242], { onTerminate: () => g.release() });
    const runner = makeRunner(ctx, {
      makeTool: (workspace) => parkedTool(workspace, g),
      jobControl: () => job.control,
    });

    const running = runner.run({ contract: contractOf(), tool_id: 'run_script', tool_arguments: {} });
    const taskId = await taskIdOf(ctx.store);

    assert.equal(typeof runner.cancel, 'function');
    const first = await runner.cancel(taskId, { reason: 'stop', requested_by: 'test' });
    const second = await runner.cancel(taskId, { reason: 'stop again', requested_by: 'someone else' });
    assert.equal(second.request_id, first.request_id);
    assert.equal(second.replayed, true);
    assert.equal(runner.canceller.pending(), 0);

    const outcome = await running;
    assert.equal(outcome.state, 'cancelled');
    assert.equal(job.state.terminated, 1);
    assert.equal(ctx.log.read({ task_id: taskId, event_type: 'task.cancel.requested' }).length, 1);
  });
});
