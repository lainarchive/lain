/**
 * Task records.
 *
 * Stored in their **own** SQLite file, separate from the event log, and for a
 * reason that is a security property rather than tidiness: the event log is the
 * system of record, and a defect in task bookkeeping must not be able to corrupt
 * it. The two databases are written in a defined order — record first, event
 * second — so the log never contains an event about a task row that does not
 * exist.
 *
 * The store owns: task identity, the admitted contract, granted capabilities,
 * state history, and results. It does not decide anything: it has no call to any
 * policy function, which `tools/check/store-boundary.mjs` verifies for the event
 * store and `tools/check/process-boundary.mjs` will verify for this one.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ulid } from '../core/ids.mjs';
import { canonicalJson } from '../core/json.mjs';
import { StoreError } from '../core/errors.mjs';
import { checkTransition, transitionRequirements } from './states.mjs';

export const TASK_SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS tasks (
  task_id        TEXT PRIMARY KEY,
  objective      TEXT NOT NULL,
  state          TEXT NOT NULL,
  effect_class   TEXT NOT NULL,
  workspace      TEXT,
  budget_json    TEXT NOT NULL,
  contract_json  TEXT NOT NULL,
  result_json    TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  origin         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_capabilities (
  task_id      TEXT NOT NULL,
  capability   TEXT NOT NULL,
  granted_at   TEXT NOT NULL,
  granted_by   TEXT NOT NULL,
  PRIMARY KEY (task_id, capability)
);

CREATE TABLE IF NOT EXISTS task_transitions (
  seq          INTEGER PRIMARY KEY,
  task_id      TEXT NOT NULL,
  from_state   TEXT NOT NULL,
  to_state     TEXT NOT NULL,
  at           TEXT NOT NULL,
  reason       TEXT,
  evidence_json TEXT
);
`;

/**
 * @param {{path: string, now?: () => number}} options
 * @returns {import('../core/types.mjs').TaskStore}
 */
export function openTaskStore(options) {
  const now = options.now ?? Date.now;
  const path = options.path;
  mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(TASK_SCHEMA_VERSION));

  const insertTask = db.prepare(
    `INSERT INTO tasks (task_id, objective, state, effect_class, workspace, budget_json, contract_json, result_json, created_at, updated_at, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
  );
  const selectTask = db.prepare('SELECT * FROM tasks WHERE task_id = ?');
  const updateState = db.prepare('UPDATE tasks SET state = ?, updated_at = ? WHERE task_id = ?');
  const updateResult = db.prepare('UPDATE tasks SET result_json = ?, updated_at = ? WHERE task_id = ?');
  const insertCapability = db.prepare(
    'INSERT OR IGNORE INTO task_capabilities (task_id, capability, granted_at, granted_by) VALUES (?, ?, ?, ?)',
  );
  const selectCapabilities = db.prepare('SELECT capability, granted_at, granted_by FROM task_capabilities WHERE task_id = ? ORDER BY capability');
  const insertTransition = db.prepare(
    'INSERT INTO task_transitions (task_id, from_state, to_state, at, reason, evidence_json) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const selectTransitions = db.prepare('SELECT * FROM task_transitions WHERE task_id = ? ORDER BY seq');
  const countTasks = db.prepare('SELECT COUNT(*) AS n FROM tasks');

  /** @param {string} taskId */
  function mustExist(taskId) {
    const row = selectTask.get(taskId);
    if (!row) throw new StoreError('TASK_NOT_FOUND', `no task ${taskId}`);
    return row;
  }

  return {
    path,

    /**
     * Create a task in `submitted`. The contract has already been validated by
     * the caller; this function stores it verbatim so the record cannot drift
     * from what was admitted.
     *
     * @param {{contract: import('../core/types.mjs').TaskContract, origin?: string}} args
     */
    create({ contract, origin = 'cli' }) {
      const taskId = ulid(now());
      const at = new Date(now()).toISOString();
      insertTask.run(
        taskId,
        contract.objective,
        'submitted',
        contract.effect_class,
        contract.workspace ?? null,
        canonicalJson(contract.budget),
        canonicalJson(contract),
        at,
        at,
        origin,
      );
      insertTransition.run(taskId, 'none', 'submitted', at, 'created', null);
      return { task_id: taskId, state: 'submitted', created_at: at };
    },

    /** @param {string} taskId */
    get(taskId) {
      const row = /** @type {Record<string, unknown>} */ (mustExist(taskId));
      return {
        task_id: /** @type {string} */ (row.task_id),
        objective: /** @type {string} */ (row.objective),
        state: /** @type {string} */ (row.state),
        effect_class: /** @type {string} */ (row.effect_class),
        workspace: /** @type {string|null} */ (row.workspace),
        budget: JSON.parse(/** @type {string} */ (row.budget_json)),
        contract: JSON.parse(/** @type {string} */ (row.contract_json)),
        result: row.result_json ? JSON.parse(/** @type {string} */ (row.result_json)) : null,
        created_at: /** @type {string} */ (row.created_at),
        updated_at: /** @type {string} */ (row.updated_at),
        origin: /** @type {string} */ (row.origin),
      };
    },

    /**
     * Set the capabilities a task holds. Callable once, at admission: a second
     * call is refused rather than merged, because merging is how a running task
     * would quietly widen its own authority.
     *
     * @param {string} taskId
     * @param {string[]} capabilities
     * @param {{granted_by: string}} meta
     */
    grantCapabilities(taskId, capabilities, meta) {
      mustExist(taskId);
      const existing = selectCapabilities.all(taskId);
      if (existing.length > 0) {
        throw new StoreError('CAPABILITIES_ALREADY_GRANTED', `task ${taskId} already holds capabilities`, {
          existing: existing.map((r) => r.capability),
        });
      }
      const at = new Date(now()).toISOString();
      for (const capability of capabilities) insertCapability.run(taskId, capability, at, meta.granted_by);
      return this.capabilities(taskId);
    },

    /** @param {string} taskId */
    capabilities(taskId) {
      return selectCapabilities.all(taskId).map((r) => /** @type {string} */ (r.capability));
    },

    /**
     * Move a task to a new state, enforcing both the transition table and the
     * evidence the target demands.
     *
     * @param {string} taskId
     * @param {string} to
     * @param {{reason?: string|null, evidence?: {requiredChecksPassed?: boolean, survivingProcesses?: number|null}, allowIllegal?: boolean}} [opts]
     */
    transition(taskId, to, opts = {}) {
      const row = mustExist(taskId);
      const from = /** @type {string} */ (row.state);
      const check = checkTransition(from, to);
      if (!check.legal) {
        // Illegal transitions are refused AND recorded: a state machine that
        // silently ignores an invalid edge hides exactly the bug it exists to
        // catch.
        const at = new Date(now()).toISOString();
        insertTransition.run(taskId, from, to, at, `refused:${check.code}`, canonicalJson({ requested: to, code: check.code }));
        throw new StoreError(check.code, `cannot move task ${taskId} from ${from} to ${to}`, { from, to });
      }
      const current = /** @type {{result_json?: string|null}} */ (row);
      const recorded = current.result_json ? JSON.parse(current.result_json) : null;
      const missing = transitionRequirements(to, {
        requiredChecksPassed: opts.evidence?.requiredChecksPassed,
        survivingProcesses: opts.evidence?.survivingProcesses,
        reason: opts.reason ?? null,
        evidenceCount: Array.isArray(recorded?.evidence) ? recorded.evidence.length : 0,
      });
      if (missing.length > 0) {
        throw new StoreError('TRANSITION_REQUIREMENTS_UNMET', `cannot move task ${taskId} to ${to}`, { missing });
      }
      const at = new Date(now()).toISOString();
      updateState.run(to, at, taskId);
      insertTransition.run(taskId, from, to, at, opts.reason ?? null, opts.evidence ? canonicalJson(opts.evidence) : null);
      return { task_id: taskId, from, to, at };
    },

    /**
     * Record the result. The schema is enforced here rather than by convention,
     * because a result missing `not_verified` is indistinguishable from one that
     * verified everything.
     *
     * @param {string} taskId
     * @param {import('../core/types.mjs').TaskResult} result
     */
    setResult(taskId, result) {
      mustExist(taskId);
      const record = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (result));
      for (const key of ['claims', 'artifacts', 'evidence', 'checks', 'not_verified', 'indeterminate']) {
        if (!Array.isArray(record[key])) {
          throw new StoreError('RESULT_SHAPE_INVALID', `result.${key} must be an array`, { key });
        }
      }
      updateResult.run(canonicalJson(result), new Date(now()).toISOString(), taskId);
      return this.get(taskId).result;
    },

    /** @param {string} taskId */
    history(taskId) {
      mustExist(taskId);
      const rows = /** @type {{seq: number, from_state: string, to_state: string, at: string, reason: string|null, evidence_json: string|null}[]} */ (
        selectTransitions.all(taskId)
      );
      return rows.map((r) => ({
        seq: r.seq,
        from: r.from_state,
        to: r.to_state,
        at: r.at,
        reason: r.reason ?? null,
        evidence: r.evidence_json ? JSON.parse(r.evidence_json) : null,
      }));
    },

    /** @param {number} [limit] */
    list(limit = 20) {
      return db
        .prepare('SELECT task_id, objective, state, created_at FROM tasks ORDER BY created_at DESC LIMIT ?')
        .all(limit);
    },

    /**
     * Check that the row, its history and its result agree.
     * @param {string} taskId
     */
    verify(taskId) {
      const findings = [];
      const row = selectTask.get(taskId);
      if (!row) return { ok: false, findings: [{ code: 'TASK_NOT_FOUND' }], state: 'unknown' };
      const rows = /** @type {{to_state: string, reason: string|null}[]} */ (selectTransitions.all(taskId));
      if (rows.length === 0) findings.push({ code: 'NO_HISTORY' });
      const final = /** @type {string} */ (row.state);
      // A refusal row ends in `refused:<code>`, which is not a state — so the
      // last *successful* transition is what must agree with the row.
      const lastSuccessful = [...rows].reverse().find((h) => !String(h.reason ?? '').startsWith('refused:'));
      if (lastSuccessful && lastSuccessful.to_state !== final) {
        findings.push({ code: 'STATE_HISTORY_MISMATCH', state: final, history: lastSuccessful.to_state });
      }
      if (final === 'completed' && !row.result_json) findings.push({ code: 'COMPLETED_WITHOUT_RESULT' });
      return { ok: findings.length === 0, findings, state: final };
    },

    stats() {
      return { tasks: /** @type {{n: number}} */ (countTasks.get()).n, schema_version: TASK_SCHEMA_VERSION };
    },

    close() {
      db.close();
    },
  };
}
