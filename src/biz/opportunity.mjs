import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ulid } from '../core/ids.mjs';

export const OPPORTUNITY_STATUSES = Object.freeze(['draft', 'validated', 'approved', 'rejected']);

export class BizError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [detail]
   */
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'BizError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * @param {number} n
 * @returns {number}
 */
function round2(n) {
  const rounded = Number(n.toFixed(2));
  return rounded === 0 ? 0 : rounded;
}

/**
 * @param {unknown} v
 * @returns {v is number}
 */
function isNonNegativeFinite(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/**
 * @param {unknown} v
 * @param {string} label
 * @param {string} code
 * @returns {string}
 */
function requireNonEmptyString(v, label, code) {
  if (typeof v !== 'string' || v.trim().length === 0) {
    throw new BizError(code, `${label} must be a non-empty string`);
  }
  return v.trim();
}

/**
 * @param {unknown} v
 * @param {string} label
 * @param {string} code
 * @returns {string[]}
 */
function requireNonEmptyStringArray(v, label, code) {
  if (!Array.isArray(v) || v.length === 0) {
    throw new BizError(code, `${label} must be a non-empty array of strings`);
  }
  return v.map((item, idx) => requireNonEmptyString(item, `${label}[${idx}]`, code));
}

/**
 * @typedef {object} UnitEconomicsInput
 * @property {number} price_usd
 * @property {number} unit_cost_usd
 * @property {number} fixed_cost_usd
 * @property {number} estimated_units
 */

/**
 * @typedef {UnitEconomicsInput & {
 *   revenue_usd: number,
 *   variable_cost_usd: number,
 *   gross_profit_usd: number,
 *   net_profit_usd: number,
 *   margin_pct: number,
 *   break_even_units: number | null,
 * }} UnitEconomics
 */

/**
 * Compute deterministic unit economics for an opportunity proposal.
 *
 * @param {UnitEconomicsInput} input
 * @returns {UnitEconomics}
 */
export function computeUnitEconomics(input) {
  if (!input || typeof input !== 'object') {
    throw new BizError('INVALID_ECONOMICS', 'economics input must be an object');
  }
  const { price_usd, unit_cost_usd, fixed_cost_usd, estimated_units } = input;
  const fields = { price_usd, unit_cost_usd, fixed_cost_usd, estimated_units };
  for (const [name, val] of Object.entries(fields)) {
    if (!isNonNegativeFinite(val)) {
      throw new BizError('INVALID_ECONOMICS', `${name} must be a finite number >= 0`, { field: name });
    }
  }

  const rawRevenue = price_usd * estimated_units;
  const rawVariableCost = unit_cost_usd * estimated_units;
  const rawGrossProfit = rawRevenue - rawVariableCost;
  const rawNetProfit = rawGrossProfit - fixed_cost_usd;

  const marginCents = Math.round((price_usd - unit_cost_usd) * 100);
  const fixedCents = Math.round(fixed_cost_usd * 100);
  return {
    price_usd,
    unit_cost_usd,
    fixed_cost_usd,
    estimated_units,
    revenue_usd: round2(rawRevenue),
    variable_cost_usd: round2(rawVariableCost),
    gross_profit_usd: round2(rawGrossProfit),
    net_profit_usd: round2(rawNetProfit),
    margin_pct: rawRevenue > 0 ? round2((rawNetProfit / rawRevenue) * 100) : 0,
    break_even_units: marginCents > 0 ? Math.ceil(fixedCents / marginCents) : null,
  };
}

/**
 * @typedef {object} OpportunityRecord
 * @property {string} id
 * @property {string} title
 * @property {string} category
 * @property {string} hypothesis
 * @property {string[]} assumptions
 * @property {string[]} risks
 * @property {string[]} validation_plan
 * @property {string[]} sources
 * @property {UnitEconomics} economics
 * @property {'draft' | 'validated' | 'approved' | 'rejected'} status
 * @property {string | null} validation_evidence
 * @property {string | null} validated_by
 * @property {string | null} validated_at
 * @property {string | null} approved_by
 * @property {string | null} approved_at
 * @property {number} approved_spend_usd
 * @property {string} created_at
 * @property {string} updated_at
 */

/**
 * @param {Record<string, unknown>} row
 * @returns {OpportunityRecord}
 */
function rowToOpportunity(row) {
  try {
    return {
      id: /** @type {string} */ (row.id),
      title: /** @type {string} */ (row.title),
      category: /** @type {string} */ (row.category),
      hypothesis: /** @type {string} */ (row.hypothesis),
      assumptions: JSON.parse(/** @type {string} */ (row.assumptions_json)),
      risks: JSON.parse(/** @type {string} */ (row.risks_json)),
      validation_plan: JSON.parse(/** @type {string} */ (row.validation_plan_json)),
      sources: JSON.parse(/** @type {string} */ (row.sources_json)),
      economics: JSON.parse(/** @type {string} */ (row.economics_json)),
      status: /** @type {'draft' | 'validated' | 'approved' | 'rejected'} */ (row.status),
      validation_evidence: /** @type {string | null} */ (row.validation_evidence ?? null),
      validated_by: /** @type {string | null} */ (row.validated_by ?? null),
      validated_at: /** @type {string | null} */ (row.validated_at ?? null),
      approved_by: /** @type {string | null} */ (row.approved_by ?? null),
      approved_at: /** @type {string | null} */ (row.approved_at ?? null),
      approved_spend_usd: /** @type {number} */ (row.approved_spend_usd),
      created_at: /** @type {string} */ (row.created_at),
      updated_at: /** @type {string} */ (row.updated_at),
    };
  } catch {
    throw new BizError('CORRUPT_RECORD', `corrupt JSON in opportunity ${row.id}`);
  }
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS opportunities (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  hypothesis TEXT NOT NULL,
  assumptions_json TEXT NOT NULL,
  risks_json TEXT NOT NULL,
  validation_plan_json TEXT NOT NULL,
  sources_json TEXT NOT NULL,
  economics_json TEXT NOT NULL,
  status TEXT NOT NULL,
  validation_evidence TEXT,
  validated_by TEXT,
  validated_at TEXT,
  approved_by TEXT,
  approved_at TEXT,
  approved_spend_usd REAL NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_opportunities_status ON opportunities (status, created_at);
`;

/**
 * Open a persistent SQLite store for business opportunities.
 *
 * Financial commitments are fail-closed: an opportunity starts in `draft`,
 * must record validation (`validated` or `rejected`), and only `validated`
 * opportunities can transition to `approved` with an explicit spend ceiling.
 *
 * @param {{ path: string, now?: () => number | string }} options
 */
export function openOpportunityStore(options) {
  if (!options || typeof options.path !== 'string' || options.path.trim().length === 0) {
    throw new BizError('STORE_PATH_REQUIRED', 'openOpportunityStore() requires a non-empty path');
  }
  const dbPath = options.path;
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
    if (closed) {
      throw new BizError('STORE_CLOSED', 'opportunity store is closed');
    }
  }

  function currentTimestamp() {
    if (!options.now) return new Date().toISOString();
    const raw = options.now();
    return typeof raw === 'number' ? new Date(raw).toISOString() : String(raw);
  }

  const insertStmt = db.prepare(`
    INSERT INTO opportunities (
      id, title, category, hypothesis,
      assumptions_json, risks_json, validation_plan_json, sources_json, economics_json,
      status, validation_evidence, validated_by, validated_at,
      approved_by, approved_at, approved_spend_usd, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', NULL, NULL, NULL, NULL, NULL, 0, ?, ?)
    RETURNING *
  `);

  const validateStmt = db.prepare(`
    UPDATE opportunities
    SET status = ?, validation_evidence = ?, validated_by = ?, validated_at = ?, updated_at = ?
    WHERE id = ? AND status = 'draft'
    RETURNING *
  `);

  const approveStmt = db.prepare(`
    UPDATE opportunities
    SET status = 'approved', approved_by = ?, approved_at = ?, approved_spend_usd = ?, updated_at = ?
    WHERE id = ? AND status = 'validated'
    RETURNING *
  `);

  const getStmt = db.prepare('SELECT * FROM opportunities WHERE id = ?');
  const statusStmt = db.prepare('SELECT status FROM opportunities WHERE id = ?');
  const listAllStmt = db.prepare('SELECT * FROM opportunities ORDER BY created_at ASC, id ASC');
  const listByStatusStmt = db.prepare('SELECT * FROM opportunities WHERE status = ? ORDER BY created_at ASC, id ASC');

  /**
   * @param {{
   *   id?: string,
   *   title: string,
   *   category: string,
   *   hypothesis: string,
   *   assumptions: string[],
   *   risks: string[],
   *   validation_plan: string[],
   *   sources: string[],
   *   economics: UnitEconomicsInput,
   * }} input
   * @returns {OpportunityRecord}
   */
  function createOpportunity(input) {
    assertOpen();
    if (!input || typeof input !== 'object') {
      throw new BizError('INVALID_OPPORTUNITY', 'opportunity input must be an object');
    }
    const id = input.id !== undefined ? requireNonEmptyString(input.id, 'id', 'INVALID_OPPORTUNITY') : ulid();
    const title = requireNonEmptyString(input.title, 'title', 'INVALID_OPPORTUNITY');
    const category = requireNonEmptyString(input.category, 'category', 'INVALID_OPPORTUNITY');
    const hypothesis = requireNonEmptyString(input.hypothesis, 'hypothesis', 'INVALID_OPPORTUNITY');
    const assumptions = requireNonEmptyStringArray(input.assumptions, 'assumptions', 'INVALID_OPPORTUNITY');
    const risks = requireNonEmptyStringArray(input.risks, 'risks', 'INVALID_OPPORTUNITY');
    const validationPlan = requireNonEmptyStringArray(input.validation_plan, 'validation_plan', 'INVALID_OPPORTUNITY');
    const sources = requireNonEmptyStringArray(input.sources, 'sources', 'INVALID_OPPORTUNITY');
    const economics = computeUnitEconomics(input.economics);

    const ts = currentTimestamp();
    /** @type {Record<string, unknown> | undefined} */
    let inserted;
    try {
      inserted = /** @type {Record<string, unknown> | undefined} */ (
        insertStmt.get(
          id,
          title,
          category,
          hypothesis,
          JSON.stringify(assumptions),
          JSON.stringify(risks),
          JSON.stringify(validationPlan),
          JSON.stringify(sources),
          JSON.stringify(economics),
          ts,
          ts,
        )
      );
    } catch (err) {
      if (err instanceof Error && err.message.includes('UNIQUE constraint failed')) {
        throw new BizError('OPPORTUNITY_EXISTS', `opportunity already exists: ${id}`, { id });
      }
      throw err;
    }

    return rowToOpportunity(/** @type {Record<string, unknown>} */ (inserted));
  }

  /**
   * @param {string} id
   * @param {{ evidence: string, passed: boolean, reviewer: string }} input
   * @returns {OpportunityRecord}
   */
  function recordValidation(id, input) {
    assertOpen();
    const oppId = requireNonEmptyString(id, 'id', 'INVALID_VALIDATION');
    if (!input || typeof input !== 'object') {
      throw new BizError('INVALID_VALIDATION', 'validation input must be an object');
    }
    const evidence = requireNonEmptyString(input.evidence, 'evidence', 'INVALID_VALIDATION');
    const reviewer = requireNonEmptyString(input.reviewer, 'reviewer', 'INVALID_VALIDATION');
    if (typeof input.passed !== 'boolean') {
      throw new BizError('INVALID_VALIDATION', 'passed must be a boolean');
    }

    const nextStatus = input.passed ? 'validated' : 'rejected';
    const ts = currentTimestamp();
    const updated = /** @type {Record<string, unknown> | undefined} */ (
      validateStmt.get(nextStatus, evidence, reviewer, ts, ts, oppId)
    );
    if (!updated) {
      const existing = statusStmt.get(oppId);
      if (!existing) {
        throw new BizError('OPPORTUNITY_NOT_FOUND', `opportunity not found: ${oppId}`, { id: oppId });
      }
      throw new BizError('INVALID_STATE', `cannot validate opportunity in state '${existing.status}'`, {
        id: oppId,
        status: existing.status,
      });
    }

    return rowToOpportunity(updated);
  }

  /**
   * @param {string} id
   * @param {{ approvedBy: string, maxSpendUsd: number }} input
   * @returns {OpportunityRecord}
   */
  function approveCommitment(id, input) {
    assertOpen();
    const oppId = requireNonEmptyString(id, 'id', 'INVALID_APPROVAL');
    if (!input || typeof input !== 'object') {
      throw new BizError('INVALID_APPROVAL', 'approval input must be an object');
    }
    const approvedBy = requireNonEmptyString(input.approvedBy, 'approvedBy', 'INVALID_APPROVAL');
    if (!isNonNegativeFinite(input.maxSpendUsd)) {
      throw new BizError('INVALID_APPROVAL', 'maxSpendUsd must be a finite number >= 0');
    }

    const ts = currentTimestamp();
    const approved = /** @type {Record<string, unknown> | undefined} */ (
      approveStmt.get(approvedBy, ts, input.maxSpendUsd, ts, oppId)
    );
    if (!approved) {
      const existing = statusStmt.get(oppId);
      if (!existing) {
        throw new BizError('OPPORTUNITY_NOT_FOUND', `opportunity not found: ${oppId}`, { id: oppId });
      }
      if (existing.status === 'draft') {
        throw new BizError('APPROVAL_REQUIRES_VALIDATION', 'cannot approve a draft opportunity before validation', {
          id: oppId,
          status: existing.status,
        });
      }
      if (existing.status === 'rejected') {
        throw new BizError('OPPORTUNITY_REJECTED', 'cannot approve a rejected opportunity', {
          id: oppId,
          status: existing.status,
        });
      }
      throw new BizError('INVALID_STATE', `cannot approve opportunity in state '${existing.status}'`, {
        id: oppId,
        status: existing.status,
      });
    }

    return rowToOpportunity(approved);
  }

  /**
   * @param {string} id
   * @returns {OpportunityRecord | null}
   */
  function get(id) {
    assertOpen();
    const row = getStmt.get(id);
    return row ? rowToOpportunity(/** @type {Record<string, unknown>} */ (row)) : null;
  }

  /**
   * @param {{ status?: 'draft' | 'validated' | 'approved' | 'rejected' }} [opts]
   * @returns {OpportunityRecord[]}
   */
  function list(opts = {}) {
    assertOpen();
    if (opts.status !== undefined) {
      if (!OPPORTUNITY_STATUSES.includes(opts.status)) {
        throw new BizError('INVALID_STATUS', `unknown status: ${opts.status}`);
      }
      return listByStatusStmt.all(opts.status).map((r) => rowToOpportunity(/** @type {Record<string, unknown>} */ (r)));
    }
    return listAllStmt.all().map((r) => rowToOpportunity(/** @type {Record<string, unknown>} */ (r)));
  }

  function close() {
    if (closed) return;
    closed = true;
    db.close();
  }

  return {
    createOpportunity,
    recordValidation,
    approveCommitment,
    get,
    list,
    close,
  };
}
