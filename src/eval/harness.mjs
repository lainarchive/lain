import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { ulid } from '../core/ids.mjs';

export const EVAL_STATUSES = Object.freeze(['active', 'rolled_back']);

export class EvalError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [detail]
   */
  constructor(code, message, detail = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.detail = detail;
  }
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS experiments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  candidate_model TEXT NOT NULL,
  baseline_model TEXT NOT NULL,
  status TEXT NOT NULL,
  source TEXT NOT NULL,
  hardware_json TEXT NOT NULL,
  rolled_back_by TEXT,
  rolled_back_at TEXT,
  rollback_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS eval_runs (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  passed INTEGER NOT NULL,
  latency_ms REAL NOT NULL,
  cost REAL NOT NULL,
  output_hash TEXT NOT NULL,
  host_snapshot_json TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_eval_runs_experiment ON eval_runs(experiment_id, model_id);
CREATE INDEX IF NOT EXISTS idx_experiments_status ON experiments(status);
`;

/**
 * @typedef {'active' | 'rolled_back'} EvalStatus
 *
 * @typedef {object} ExperimentRecord
 * @property {string} id
 * @property {string} name
 * @property {string} candidate_model
 * @property {string} baseline_model
 * @property {EvalStatus} status
 * @property {string} source
 * @property {Record<string, unknown>} hardware
 * @property {string | null} rolled_back_by
 * @property {string | null} rolled_back_at
 * @property {string | null} rollback_reason
 * @property {string} created_at
 * @property {string} updated_at
 *
 * @typedef {object} EvalTask
 * @property {string} id
 * @property {string} objective
 * @property {string} [expected_substring]
 *
 * @typedef {object} RunnerResult
 * @property {string} answer
 * @property {number} [cost]
 * @property {number} [latency_ms]
 * @property {boolean} [passed]
 *
 * @typedef {(task: EvalTask, modelId: string) => RunnerResult | Promise<RunnerResult>} EvalRunner
 *
 * @typedef {object} EvalSuiteSummary
 * @property {string} experiment_id
 * @property {string} model_id
 * @property {number} total
 * @property {number} passed
 * @property {number} failed
 * @property {number} pass_rate
 * @property {number} avg_latency_ms
 * @property {number} total_cost
 *
 * @typedef {object} ModelMetrics
 * @property {string} model_id
 * @property {number} total
 * @property {number} passed
 * @property {number} failed
 * @property {number} pass_rate
 * @property {number} avg_latency_ms
 * @property {number} total_cost
 *
 * @typedef {object} CandidateComparison
 * @property {string} experiment_id
 * @property {EvalStatus} status
 * @property {ModelMetrics} baseline
 * @property {ModelMetrics} candidate
 * @property {'insufficient_data' | 'promote_candidate' | 'keep_baseline'} recommendation
 *
 * @typedef {object} EvalRunRecord
 * @property {string} id
 * @property {string} experiment_id
 * @property {string} task_id
 * @property {string} model_id
 * @property {boolean} passed
 * @property {number} latency_ms
 * @property {number} cost
 * @property {string} output_hash
 * @property {Record<string, unknown>} host_snapshot
 * @property {string} recorded_at
 */

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
function requireNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new EvalError('INVALID_INPUT', `${field} must be a non-empty string`, { field });
  }
  return value;
}

/**
 * @param {() => number | string | Date} now
 * @returns {string}
 */
function formatTimestamp(now) {
  const value = now();
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

/**
 * @param {Record<string, unknown>} row
 * @returns {ExperimentRecord}
 */
function hydrateExperiment(row) {
  return {
    id: /** @type {string} */ (row.id),
    name: /** @type {string} */ (row.name),
    candidate_model: /** @type {string} */ (row.candidate_model),
    baseline_model: /** @type {string} */ (row.baseline_model),
    status: /** @type {EvalStatus} */ (row.status),
    source: /** @type {string} */ (row.source),
    hardware: /** @type {Record<string, unknown>} */ (JSON.parse(/** @type {string} */ (row.hardware_json))),
    rolled_back_by: /** @type {string | null} */ (row.rolled_back_by ?? null),
    rolled_back_at: /** @type {string | null} */ (row.rolled_back_at ?? null),
    rollback_reason: /** @type {string | null} */ (row.rollback_reason ?? null),
    created_at: /** @type {string} */ (row.created_at),
    updated_at: /** @type {string} */ (row.updated_at),
  };
}

/**
 * @param {Record<string, unknown>} row
 * @returns {EvalRunRecord}
 */
function hydrateRun(row) {
  return {
    id: /** @type {string} */ (row.id),
    experiment_id: /** @type {string} */ (row.experiment_id),
    task_id: /** @type {string} */ (row.task_id),
    model_id: /** @type {string} */ (row.model_id),
    passed: Boolean(row.passed),
    latency_ms: /** @type {number} */ (row.latency_ms),
    cost: /** @type {number} */ (row.cost),
    output_hash: /** @type {string} */ (row.output_hash),
    host_snapshot: /** @type {Record<string, unknown>} */ (
      JSON.parse(/** @type {string} */ (row.host_snapshot_json))
    ),
    recorded_at: /** @type {string} */ (row.recorded_at),
  };
}

/**
 * @param {EvalTask} task
 * @param {string} modelId
 * @returns {RunnerResult}
 */
function defaultMockRunner(task, modelId) {
  return { answer: `mock:${modelId}:${task.id}`, cost: 0 };
}

/**
 * @param {object} options
 * @param {string} options.path
 * @param {() => number | string | Date} [options.now]
 */
export function openExperimentRegistry(options) {
  if (!options || typeof options.path !== 'string' || options.path.trim().length === 0) {
    throw new EvalError('INVALID_INPUT', 'openExperimentRegistry() requires a non-empty path');
  }
  const dbPath = options.path;
  const now = options.now ?? (() => Date.now());

  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = FULL');
  db.exec(SCHEMA_SQL);

  let closed = false;
  function assertOpen() {
    if (closed) throw new EvalError('REGISTRY_CLOSED', 'experiment registry is closed');
  }

  const stmtInsertExperiment = db.prepare(`
    INSERT INTO experiments (
      id, name, candidate_model, baseline_model, status, source, hardware_json,
      rolled_back_by, rolled_back_at, rollback_reason, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'active', ?, ?, NULL, NULL, NULL, ?, ?)
  `);
  const stmtGetExperiment = db.prepare('SELECT * FROM experiments WHERE id = ?');
  const stmtListAll = db.prepare('SELECT * FROM experiments ORDER BY created_at ASC, id ASC');
  const stmtListByStatus = db.prepare(
    'SELECT * FROM experiments WHERE status = ? ORDER BY created_at ASC, id ASC',
  );
  const stmtInsertRun = db.prepare(`
    INSERT INTO eval_runs (
      id, experiment_id, task_id, model_id, passed, latency_ms, cost,
      output_hash, host_snapshot_json, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const stmtAggregateModel = db.prepare(`
    SELECT
      COUNT(*) AS total,
      COALESCE(SUM(passed), 0) AS passed,
      COALESCE(AVG(latency_ms), 0) AS avg_latency_ms,
      COALESCE(SUM(cost), 0) AS total_cost
    FROM eval_runs
    WHERE experiment_id = ? AND model_id = ?
  `);
  const stmtTaskIds = db.prepare(
    'SELECT DISTINCT task_id FROM eval_runs WHERE experiment_id = ? AND model_id = ? ORDER BY task_id ASC',
  );
  const stmtListRuns = db.prepare(
    'SELECT * FROM eval_runs WHERE experiment_id = ? ORDER BY recorded_at ASC, id ASC',
  );
  const stmtRollback = db.prepare(`
    UPDATE experiments
    SET status = 'rolled_back',
        rolled_back_by = ?,
        rolled_back_at = ?,
        rollback_reason = ?,
        updated_at = ?
    WHERE id = ? AND status != 'rolled_back'
  `);

  /**
   * @param {string} id
   * @returns {ExperimentRecord | null}
   */
  function get(id) {
    assertOpen();
    requireNonEmptyString(id, 'id');
    const row = /** @type {Record<string, unknown> | undefined} */ (stmtGetExperiment.get(id));
    return row ? hydrateExperiment(row) : null;
  }

  /**
   * @param {{ status?: EvalStatus }} [filter]
   * @returns {ExperimentRecord[]}
   */
  function list(filter = {}) {
    assertOpen();
    if (filter.status !== undefined) {
      if (!EVAL_STATUSES.includes(filter.status)) {
        throw new EvalError('INVALID_STATUS', `unknown experiment status: ${String(filter.status)}`, {
          status: filter.status,
        });
      }
      const rows = /** @type {Record<string, unknown>[]} */ (stmtListByStatus.all(filter.status));
      return rows.map(hydrateExperiment);
    }
    const rows = /** @type {Record<string, unknown>[]} */ (stmtListAll.all());
    return rows.map(hydrateExperiment);
  }

  /**
   * @param {object} input
   * @param {string} [input.id]
   * @param {string} input.name
   * @param {string} input.candidateModel
   * @param {string} input.baselineModel
   * @param {string} input.source
   * @param {Record<string, unknown>} [input.hardware]
   * @returns {ExperimentRecord}
   */
  function registerExperiment(input) {
    if (!input || typeof input !== 'object') {
      throw new EvalError('INVALID_INPUT', 'registerExperiment() requires an options object');
    }
    const id = input.id === undefined ? ulid() : requireNonEmptyString(input.id, 'id');
    const name = requireNonEmptyString(input.name, 'name');
    const candidateModel = requireNonEmptyString(input.candidateModel, 'candidateModel');
    const baselineModel = requireNonEmptyString(input.baselineModel, 'baselineModel');
    const source = requireNonEmptyString(input.source, 'source');
    const hardwareJson = JSON.stringify(input.hardware ?? {});
    const ts = formatTimestamp(now);
    assertOpen();

    try {
      stmtInsertExperiment.run(id, name, candidateModel, baselineModel, source, hardwareJson, ts, ts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('UNIQUE constraint failed') || msg.includes('PRIMARY KEY')) {
        throw new EvalError('EXPERIMENT_EXISTS', `experiment already exists: ${id}`, { id });
      }
      throw err;
    }

    return /** @type {ExperimentRecord} */ (get(id));
  }

  /**
   * @param {object} input
   * @param {string} input.experimentId
   * @param {string} input.modelId
   * @param {EvalTask[]} input.tasks
   * @param {EvalRunner} [input.runner]
   * @param {Record<string, unknown>} [input.hostSnapshot]
   * @returns {Promise<EvalSuiteSummary>}
   */
  async function runEvalSuite(input) {
    if (!input || typeof input !== 'object') {
      throw new EvalError('INVALID_INPUT', 'runEvalSuite() requires an options object');
    }
    const experimentId = requireNonEmptyString(input.experimentId, 'experimentId');
    const modelId = requireNonEmptyString(input.modelId, 'modelId');
    if (!Array.isArray(input.tasks) || input.tasks.length === 0) {
      throw new EvalError('INVALID_TASKS', 'tasks must be a non-empty array');
    }
    for (const task of input.tasks) {
      if (!task || typeof task !== 'object') {
        throw new EvalError('INVALID_TASKS', 'each task must be an object');
      }
      requireNonEmptyString(task.id, 'task.id');
      requireNonEmptyString(task.objective, 'task.objective');
    }

    assertOpen();
    const exp = get(experimentId);
    if (!exp) {
      throw new EvalError('EXPERIMENT_NOT_FOUND', `experiment not found: ${experimentId}`, {
        experimentId,
      });
    }
    if (exp.status !== 'active') {
      throw new EvalError(
        'EXPERIMENT_ROLLED_BACK',
        `experiment ${experimentId} is rolled back and cannot run evaluations`,
        { experimentId, status: exp.status },
      );
    }
    if (modelId !== exp.baseline_model && modelId !== exp.candidate_model) {
      throw new EvalError(
        'UNKNOWN_MODEL',
        `model ${modelId} is neither baseline (${exp.baseline_model}) nor candidate (${exp.candidate_model})`,
        { experimentId, modelId },
      );
    }

    const runner = input.runner ?? defaultMockRunner;
    const hostSnapshotJson = JSON.stringify(input.hostSnapshot ?? {});

    /** @type {Array<{ id: string, taskId: string, passed: number, latencyMs: number, cost: number, outputHash: string, recordedAt: string }>} */
    const results = [];
    let passedCount = 0;
    let totalLatency = 0;
    let totalCost = 0;

    for (const task of input.tasks) {
      const t0 = performance.now();
      const raw = await runner(task, modelId);
      const measuredMs = Math.max(0, performance.now() - t0);

      const answer = typeof raw === 'string' ? raw : typeof raw?.answer === 'string' ? raw.answer : '';
      const latencyMs =
        typeof raw === 'object' &&
        raw !== null &&
        typeof raw.latency_ms === 'number' &&
        Number.isFinite(raw.latency_ms) &&
        raw.latency_ms >= 0
          ? raw.latency_ms
          : measuredMs;
      const cost =
        typeof raw === 'object' &&
        raw !== null &&
        typeof raw.cost === 'number' &&
        Number.isFinite(raw.cost) &&
        raw.cost >= 0
          ? raw.cost
          : 0;
      const passed =
        typeof raw === 'object' && raw !== null && typeof raw.passed === 'boolean'
          ? raw.passed
          : typeof task.expected_substring === 'string'
            ? answer.includes(task.expected_substring)
            : answer.length > 0;

      const outputHash = createHash('sha256').update(answer, 'utf8').digest('hex');
      const recordedAt = formatTimestamp(now);

      if (passed) passedCount += 1;
      totalLatency += latencyMs;
      totalCost += cost;

      results.push({
        id: ulid(),
        taskId: task.id,
        passed: passed ? 1 : 0,
        latencyMs,
        cost,
        outputHash,
        recordedAt,
      });
    }

    // Re-check status inside the write transaction so a concurrent rollback
    // cannot be followed by orphaned eval_runs.
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = get(experimentId);
      if (!current) {
        throw new EvalError('EXPERIMENT_NOT_FOUND', `experiment not found: ${experimentId}`, {
          experimentId,
        });
      }
      if (current.status !== 'active') {
        throw new EvalError(
          'EXPERIMENT_ROLLED_BACK',
          `experiment ${experimentId} is rolled back and cannot run evaluations`,
          { experimentId, status: current.status },
        );
      }
      for (const r of results) {
        stmtInsertRun.run(
          r.id,
          experimentId,
          r.taskId,
          modelId,
          r.passed,
          r.latencyMs,
          r.cost,
          r.outputHash,
          hostSnapshotJson,
          r.recordedAt,
        );
      }
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* ignore rollback failure after original error */
      }
      throw err;
    }

    const total = results.length;
    return {
      experiment_id: experimentId,
      model_id: modelId,
      total,
      passed: passedCount,
      failed: total - passedCount,
      pass_rate: passedCount / total,
      avg_latency_ms: totalLatency / total,
      total_cost: totalCost,
    };
  }

  /**
   * @param {string} experimentId
   * @param {string} modelId
   * @returns {ModelMetrics}
   */
  function aggregateModel(experimentId, modelId) {
    const row = /** @type {Record<string, unknown>} */ (
      stmtAggregateModel.get(experimentId, modelId)
    );
    const total = Number(row.total ?? 0);
    const passed = Number(row.passed ?? 0);
    return {
      model_id: modelId,
      total,
      passed,
      failed: total - passed,
      pass_rate: total > 0 ? passed / total : 0,
      avg_latency_ms: Number(row.avg_latency_ms ?? 0),
      total_cost: Number(row.total_cost ?? 0),
    };
  }

  /**
   * @param {string} experimentId
   * @returns {CandidateComparison}
   */
  function compareCandidates(experimentId) {
    assertOpen();
    requireNonEmptyString(experimentId, 'experimentId');

    db.exec('BEGIN DEFERRED');
    try {
      const exp = get(experimentId);
      if (!exp) {
        throw new EvalError('EXPERIMENT_NOT_FOUND', `experiment not found: ${experimentId}`, {
          experimentId,
        });
      }

      const baseline = aggregateModel(experimentId, exp.baseline_model);
      const candidate = aggregateModel(experimentId, exp.candidate_model);
      const baseTasks = stmtTaskIds.all(experimentId, exp.baseline_model).map((r) => String(r.task_id));
      const candTasks = stmtTaskIds.all(experimentId, exp.candidate_model).map((r) => String(r.task_id));
      const taskSetMatch =
        baseTasks.length === candTasks.length && baseTasks.every((id, idx) => id === candTasks[idx]);

      /** @type {'insufficient_data' | 'promote_candidate' | 'keep_baseline'} */
      let recommendation = 'keep_baseline';
      if (baseline.total === 0 || candidate.total === 0 || !taskSetMatch) {
        recommendation = 'insufficient_data';
      } else if (
        candidate.pass_rate > baseline.pass_rate ||
        (candidate.pass_rate === baseline.pass_rate &&
          (candidate.avg_latency_ms < baseline.avg_latency_ms ||
            (candidate.avg_latency_ms === baseline.avg_latency_ms &&
              candidate.total_cost < baseline.total_cost)))
      ) {
        recommendation = 'promote_candidate';
      }

      db.exec('COMMIT');
      return {
        experiment_id: experimentId,
        status: exp.status,
        baseline,
        candidate,
        recommendation,
      };
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Ignore rollback failure on read-only snapshot errors.
      }
      throw err;
    }
  }

  /**
   * @param {string} experimentId
   * @param {{ rolledBackBy: string, reason?: string }} opts
   * @returns {ExperimentRecord}
   */
  function rollbackExperiment(experimentId, opts) {
    assertOpen();
    requireNonEmptyString(experimentId, 'experimentId');
    if (!opts || typeof opts !== 'object') {
      throw new EvalError('INVALID_INPUT', 'rollbackExperiment() requires options');
    }
    const rolledBackBy = requireNonEmptyString(opts.rolledBackBy, 'rolledBackBy');
    const reason = opts.reason ?? '';
    if (typeof reason !== 'string') {
      throw new EvalError('INVALID_INPUT', 'reason must be a string', { field: 'reason' });
    }
    const ts = formatTimestamp(now);

    const info = stmtRollback.run(rolledBackBy, ts, reason, ts, experimentId);
    if (info.changes === 0) {
      const existing = get(experimentId);
      if (!existing) {
        throw new EvalError('EXPERIMENT_NOT_FOUND', `experiment not found: ${experimentId}`, {
          experimentId,
        });
      }
      throw new EvalError(
        'ALREADY_ROLLED_BACK',
        `experiment ${experimentId} is already rolled back`,
        { experimentId },
      );
    }

    return /** @type {ExperimentRecord} */ (get(experimentId));
  }

  /**
   * @param {string} experimentId
   * @returns {EvalRunRecord[]}
   */
  function listRuns(experimentId) {
    assertOpen();
    requireNonEmptyString(experimentId, 'experimentId');
    const rows = /** @type {Record<string, unknown>[]} */ (stmtListRuns.all(experimentId));
    return rows.map(hydrateRun);
  }

  function close() {
    if (closed) return;
    closed = true;
    db.close();
  }

  return {
    registerExperiment,
    runEvalSuite,
    compareCandidates,
    rollbackExperiment,
    get,
    list,
    listRuns,
    close,
  };
}
