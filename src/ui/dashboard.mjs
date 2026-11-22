/**
 * Live task dashboard: state, string renderer and OpenTUI view.
 *
 * One module holds all three layers on purpose: the state layer is the
 * contract the tests exercise without a terminal, the string renderer is the
 * snapshot target, and the OpenTUI view is a thin projection of the same
 * state. The measured basis for the view: @opentui/core 0.9.0 (Node >= 26.4,
 * Zig core via FFI) — TextTableRenderable has no row mutation, so the table
 * is updated by reassigning `content`; a ScrollBox's children are the
 * scrolled content; TextRenderable.add() appends one log line.
 */
import {
  BoxRenderable,
  createTextAttributes,
  ScrollBoxRenderable,
  t,
  TextRenderable,
  TextTableRenderable,
} from '@opentui/core';
import { eventBus, TASK_EVENT } from '../model/eventBus.mjs';

/** The Core events that move a task's status, mapped to the dashboard's word for each. */
/** @type {Record<string, string>} */
const STATUS_BY_EVENT = {
  'task.created': 'created',
  'task.admitted': 'admitted',
  'task.running': 'running',
  'task.completed': 'completed',
  'task.failed': 'failed',
  'task.run.abandoned': 'abandoned',
};

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'abandoned']);

/**
 * The dashboard's mutable state: one row per task in first-seen order, plus a
 * bounded log of everything that crossed the bus.
 *
 * @typedef {object} DashboardState
 * @property {Map<string, {task_id: string, status: string, started_at: string, finished_at: string}>} tasks
 * @property {string[]} order
 * @property {string[]} log
 * @property {number} logLimit
 */

/**
 * @param {{ logLimit?: number }} [options]
 * @returns {DashboardState}
 */
export function createDashboardState({ logLimit = 200 } = {}) {
  return { tasks: new Map(), order: [], log: [], logLimit };
}

/**
 * The clock column shows the ISO time-of-day slice, deliberately not
 * toLocaleTimeString: a snapshot test must not depend on the machine locale.
 * @param {string} iso
 * @returns {string}
 */
function clockOf(iso) {
  return iso.length >= 19 ? iso.slice(11, 19) : '--------';
}

/**
 * Scalar payload fields as `k=v` pairs — enough to read an event in the log
 * without ever dumping a payload wholesale.
 * @param {Record<string, unknown>} [payload]
 * @returns {string}
 */
function payloadSummary(payload) {
  if (!payload) return '';
  const parts = Object.entries(payload)
    .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
    .map(([key, value]) => `${key}=${String(value)}`);
  return parts.join(' ').slice(0, 80);
}

/**
 * Apply one task event: always append a log line; move the task's row when
 * the event carries a status. Unknown event types are logged, never invented
 * into statuses.
 *
 * @param {DashboardState} state
 * @param {{event_type: string, payload?: Record<string, unknown>, task_id?: string, occurred_at?: string}} event
 * @returns {string} the log line that was appended
 */
export function applyTaskEvent(state, event) {
  const occurredAt = typeof event.occurred_at === 'string' ? event.occurred_at : '';
  const taskId = typeof event.task_id === 'string' ? event.task_id : '-';
  const line = `${clockOf(occurredAt)}  ${taskId.slice(0, 24).padEnd(24)}  ${event.event_type}  ${payloadSummary(event.payload)}`.trimEnd();
  state.log.push(line);
  if (state.log.length > state.logLimit) state.log.splice(0, state.log.length - state.logLimit);

  const status = STATUS_BY_EVENT[event.event_type];
  if (status) {
    let row = state.tasks.get(taskId);
    if (!row) {
      row = { task_id: taskId, status: 'created', started_at: occurredAt, finished_at: '' };
      state.tasks.set(taskId, row);
      state.order.push(taskId);
    }
    row.status = status;
    if (TERMINAL_STATUSES.has(status)) row.finished_at = occurredAt;
  }
  return line;
}

/**
 * Render the state as a plain string — the deterministic snapshot target and
 * the fallback view when no terminal is available.
 *
 * @param {DashboardState} state
 * @param {{ width?: number, logLines?: number }} [options]
 * @returns {string}
 */
export function renderDashboard(state, { width = 76, logLines = 12 } = {}) {
  const lines = [];
  lines.push(`lain dashboard — ${state.order.length} task(s), log ${state.log.length} line(s)`.slice(0, width));
  lines.push('-'.repeat(width));
  lines.push(`${'ID'.padEnd(24)}  ${'STATUS'.padEnd(10)}  ${'STARTED'.padEnd(8)}  ${'FINISHED'.padEnd(8)}`);
  for (const id of state.order) {
    const row = /** @type {{task_id: string, status: string, started_at: string, finished_at: string}} */ (state.tasks.get(id));
    lines.push(
      `${row.task_id.slice(0, 24).padEnd(24)}  ${row.status.padEnd(10)}  ${clockOf(row.started_at).padEnd(8)}  ${clockOf(row.finished_at).padEnd(8)}`,
    );
  }
  lines.push('-'.repeat(width));
  const tail = state.log.slice(-logLines);
  lines.push(`log (last ${tail.length})`);
  for (const line of tail) lines.push(line.slice(0, width));
  return lines.join('\n');
}

/**
 * The dashboard's key bindings, extracted from the mount so the same wiring
 * main.mjs installs can be driven headlessly by the test renderer.
 *
 * @param {{name: string, ctrl?: boolean}} key
 * @param {{requestRefresh: () => void, scrollLog: (delta: number) => void}} view
 * @param {{quit: () => void}} actions
 * @returns {'quit' | 'refresh' | 'scroll-up' | 'scroll-down' | 'ignored'}
 */
export function handleDashboardKey(key, view, { quit }) {
  if (key.name === 'q' || (key.ctrl === true && key.name === 'c')) {
    quit();
    return 'quit';
  }
  if (key.name === 'r') {
    view.requestRefresh();
    return 'refresh';
  }
  if (key.name === 'up') {
    view.scrollLog(-2);
    return 'scroll-up';
  }
  if (key.name === 'down') {
    view.scrollLog(2);
    return 'scroll-down';
  }
  return 'ignored';
}

/**
 * @param {DashboardState} state
 * @returns {import('@opentui/core').TextTableContent}
 */
function tableContent(state) {
  const cell = /** @param {string} text @returns {import('@opentui/core').TextTableCellContent} */ (text) => t`${text}`.chunks;
  // Header chunks are built by hand: the styled-text helpers (bold et al)
  // returned chunks the renderer printed as "[object Object]" in the measured
  // frame, while t`` chunks and this explicit shape render correctly.
  const headerCell = /** @param {string} text @returns {import('@opentui/core').TextTableCellContent} */ (text) => [
    { __isChunk: true, text, attributes: createTextAttributes({ bold: true }) },
  ];
  // One row of four cells: TextTableContent is rows-of-cells, so each cell
  // must sit inside the SAME outer array. (The first draft nested each header
  // cell in its own row and the renderer printed the objects raw.)
  const header = [headerCell('ID'), headerCell('STATUS'), headerCell('STARTED'), headerCell('FINISHED')];
  const rows = state.order.map((id) => {
    const row = /** @type {{task_id: string, status: string, started_at: string, finished_at: string}} */ (state.tasks.get(id));
    return [cell(row.task_id), cell(row.status), cell(clockOf(row.started_at)), cell(clockOf(row.finished_at))];
  });
  return /** @type {import('@opentui/core').TextTableContent} */ ([...header, ...rows]);
}

/**
 * Mount the live dashboard into a renderer and subscribe it to the bus.
 * The caller owns the renderer lifecycle; dispose() only detaches the view.
 *
 * @param {import('@opentui/core').CliRenderer} renderer
 * @param {{ bus?: import('node:events').EventEmitter }} [options]
 */
export function mountDashboard(renderer, options = {}) {
  const bus = options.bus ?? eventBus;
  const state = createDashboardState();
  const root = new BoxRenderable(renderer, { width: '100%', height: '100%' });
  const title = new TextRenderable(renderer, { content: 'lain dashboard' });
  const logBox = new ScrollBoxRenderable(renderer, {
    scrollY: true,
    // stickyScroll was measured to override manual scrolling (the pin to
    // bottom wins every render), so the follow behaviour lives here instead:
    // append scrolls to the newest line unless the user has scrolled up.
    // A fixed height keeps the log on screen no matter how long the table
    // below grows — the table clips at the frame edge instead.
    height: 8,
  });
  const table = new TextTableRenderable(renderer, { showBorders: false, columnWidthMode: 'content' });
  const logText = new TextRenderable(renderer, { content: '' });
  logBox.add(logText);
  root.add(title);
  root.add(logBox);
  root.add(table);
  renderer.root.add(root);

  const paintTable = () => {
    table.content = tableContent(state);
  };
  /** The log follows new lines until the user scrolls up; scrolling down resumes. */
  let followLog = true;
  const onTaskEvent = (/** @type {import('../model/eventBus.mjs').TaskEventRecord} */ event) => {
    const line = applyTaskEvent(state, event);
    paintTable();
    // TextRenderable.add does not imply a line break — measured: consecutive
    // adds concatenated into one wrapped line — so each line ends in \n.
    logText.add(`${line}\n`);
    if (followLog) logBox.scrollChildIntoView(logText, { align: 'end' });
    renderer.requestRender();
  };
  bus.on(TASK_EVENT, onTaskEvent);
  paintTable();

  return {
    state,
    requestRefresh: () => renderer.requestRender(),
    scrollLog: (/** @type {number} */ delta) => {
      if (delta < 0) followLog = false;
      if (delta > 0) followLog = true;
      logBox.scrollBy({ x: 0, y: delta }, 'absolute');
    },
    dispose: () => {
      bus.off(TASK_EVENT, onTaskEvent);
      renderer.root.remove(root);
    },
  };
}
