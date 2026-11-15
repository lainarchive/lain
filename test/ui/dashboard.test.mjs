/**
 * @generated
 * @purpose  M-9 dashboard: the state machine, the deterministic renderer, the bus wiring, and the real OpenTUI frame
 * @requires Chief-of-Staff
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createTestRenderer } from '@opentui/core/testing';
import { createEventBus, publishTaskEvent, TASK_EVENT } from '../../src/model/eventBus.mjs';
import {
  applyTaskEvent,
  createDashboardState,
  handleDashboardKey,
  mountDashboard,
  renderDashboard,
} from '../../src/ui/dashboard.mjs';

const T0 = '2026-11-15T01:02:03.000Z';
const T1 = '2026-11-15T01:02:04.000Z';
const T2 = '2026-11-15T01:02:05.000Z';
const T3 = '2026-11-15T01:02:06.000Z';

/**
 * @param {string} task_id
 * @param {string} event_type
 * @param {Record<string, unknown>} [payload]
 * @param {string} [occurred_at]
 */
function ev(task_id, event_type, payload = {}, occurred_at = T0) {
  return { event_type, payload, task_id, occurred_at };
}

test('AT-M9-01 lifecycle events move one row through its statuses in first-seen order', () => {
  const state = createDashboardState();
  applyTaskEvent(state, ev('task-one', 'task.created', { objective: 'demo' }, T0));
  applyTaskEvent(state, ev('task-one', 'task.admitted', {}, T1));
  applyTaskEvent(state, ev('task-two', 'task.created', {}, T1));
  applyTaskEvent(state, ev('task-one', 'task.running', {}, T2));
  applyTaskEvent(state, ev('task-one', 'task.completed', { checks: 2, passed: 2 }, T3));
  applyTaskEvent(state, ev('task-two', 'task.running', {}, T3));
  applyTaskEvent(state, ev('task-two', 'task.failed', { reason_code: 'TOOL_FAILED' }, T3));

  assert.deepEqual(state.order, ['task-one', 'task-two']);
  const one = /** @type {{status: string, started_at: string, finished_at: string}} */ (state.tasks.get('task-one'));
  const two = /** @type {{status: string, started_at: string, finished_at: string}} */ (state.tasks.get('task-two'));
  assert.equal(one.status, 'completed');
  assert.equal(one.started_at, T0);
  assert.equal(one.finished_at, T3);
  assert.equal(two.status, 'failed');
  assert.equal(two.finished_at, T3);
  assert.equal(state.log.length, 7);
});

test('AT-M9-02 an unknown event type is logged but never invented into a status', () => {
  const state = createDashboardState();
  const line = applyTaskEvent(state, ev('task-x', 'task.cancel.request_failed', { reason: 'busy' }, T0));
  assert.match(line, /task\.cancel\.request_failed/);
  assert.match(line, /reason=busy/);
  assert.equal(state.order.length, 0);
  assert.equal(state.log.length, 1);
});

test('AT-M9-03 the log keeps its bound: oldest lines fall off, the latest survive', () => {
  const state = createDashboardState({ logLimit: 3 });
  for (let i = 0; i < 5; i++) {
    applyTaskEvent(state, ev(`task-${i}`, 'task.created', {}, T0));
  }
  assert.equal(state.log.length, 3);
  assert.match(state.log[2] ?? '', /task-4/);
  assert.doesNotMatch(state.log.join('\n'), /task-0/);
});

test('AT-M9-04 renderDashboard is a deterministic snapshot', () => {
  const state = createDashboardState();
  applyTaskEvent(state, ev('task-one', 'task.created', { objective: 'demo' }, T0));
  applyTaskEvent(state, ev('task-one', 'task.completed', { checks: 2, passed: 2 }, T3));
  applyTaskEvent(state, ev('task-two', 'task.running', {}, T3));
  assert.equal(
    renderDashboard(state, { width: 76, logLines: 12 }),
    [
      'lain dashboard — 2 task(s), log 3 line(s)',
      '----------------------------------------------------------------------------',
      'ID                        STATUS      STARTED   FINISHED',
      'task-one                  completed   01:02:03  01:02:06',
      'task-two                  running     01:02:06  --------',
      '----------------------------------------------------------------------------',
      'log (last 3)',
      '01:02:03  task-one                  task.created  objective=demo',
      '01:02:06  task-one                  task.completed  checks=2 passed=2',
      '01:02:06  task-two                  task.running',
    ].join('\n'),
  );
});

test('AT-M9-05 the bus delivers exactly what publishTaskEvent was given', () => {
  const bus = createEventBus();
  /** @type {unknown[]} */
  const seen = [];
  bus.on(TASK_EVENT, (/** @type {unknown} */ record) => seen.push(record));
  const record = ev('task-bus', 'task.created', {}, T0);
  publishTaskEvent(record, { bus });
  assert.deepEqual(seen, [record]);
});

test('AT-M9-06 a real OpenTUI frame shows the task table and the log', async () => {
  const bus = createEventBus();
  const setup = await createTestRenderer({ width: 80, height: 24, exitOnCtrlC: false });
  try {
    const view = mountDashboard(setup.renderer, { bus });
    publishTaskEvent(ev('task-live-1', 'task.created', { objective: 'demo' }, T0), { bus });
    publishTaskEvent(ev('task-live-1', 'task.completed', { checks: 1, passed: 1 }, T1), { bus });
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    assert.match(frame, /lain dashboard/);
    assert.match(frame, /task-live-1/);
    assert.match(frame, /completed/);
    assert.match(frame, /task\.created/);
    view.dispose();
  } finally {
    await setup.dispose();
  }
});

test('AT-M9-07 the log follows new lines, a scroll-up moves away, a scroll-down resumes', async () => {
  const bus = createEventBus();
  const setup = await createTestRenderer({ width: 80, height: 24, exitOnCtrlC: false });
  try {
    const view = mountDashboard(setup.renderer, { bus });
    setup.renderer.keyInput.on('keypress', (/** @type {import('@opentui/core').KeyEvent} */ key) => {
      handleDashboardKey(key, view, { quit: () => {} });
    });
    for (let i = 0; i < 30; i++) {
      publishTaskEvent(ev(`task-${i}`, 'task.created', { n: i }, T0), { bus });
    }
    await setup.renderOnce();
    const following = setup.captureCharFrame();
    assert.match(following, /n=29/);
    setup.mockInput.pressArrow('up');
    await setup.renderOnce();
    const scrolledUp = setup.captureCharFrame();
    assert.notEqual(scrolledUp, following);
    assert.doesNotMatch(scrolledUp, /n=29/);
    setup.mockInput.pressArrow('down');
    await setup.renderOnce();
    const scrolledBack = setup.captureCharFrame();
    assert.match(scrolledBack, /n=29/);
    view.dispose();
  } finally {
    await setup.dispose();
  }
});

test('AT-M9-08 dispose detaches the view from the bus', async () => {
  const bus = createEventBus();
  const setup = await createTestRenderer({ width: 80, height: 24, exitOnCtrlC: false });
  try {
    const view = mountDashboard(setup.renderer, { bus });
    assert.equal(bus.listenerCount(TASK_EVENT), 1);
    view.dispose();
    assert.equal(bus.listenerCount(TASK_EVENT), 0);
  } finally {
    await setup.dispose();
  }
});

test('AT-M9-09 the key handler maps keys to actions', () => {
  let quitCalled = 0;
  let refreshed = 0;
  let scrolled = 0;
  const view = { requestRefresh: () => refreshed++, scrollLog: (/** @type {number} */ d) => { scrolled += d; } };
  assert.equal(handleDashboardKey({ name: 'q' }, view, { quit: () => quitCalled++ }), 'quit');
  assert.equal(handleDashboardKey({ name: 'c', ctrl: true }, view, { quit: () => quitCalled++ }), 'quit');
  assert.equal(quitCalled, 2);
  assert.equal(handleDashboardKey({ name: 'r' }, view, { quit: () => {} }), 'refresh');
  assert.equal(refreshed, 1);
  assert.equal(handleDashboardKey({ name: 'up' }, view, { quit: () => {} }), 'scroll-up');
  assert.equal(handleDashboardKey({ name: 'down' }, view, { quit: () => {} }), 'scroll-down');
  assert.equal(scrolled, 0);
  assert.equal(handleDashboardKey({ name: 'x' }, view, { quit: () => {} }), 'ignored');
});
