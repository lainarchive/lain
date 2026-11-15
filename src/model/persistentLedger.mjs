/**
 * @generated
 * @purpose  M-6 persistent approval ledger: the in-memory record, written through to SQLite
 * @requires Chief-of-Staff
 */
import { DatabaseSync } from 'node:sqlite';
import { StoreError } from '../core/errors.mjs';
import { decide, permitsExecution } from '../policy/decide.mjs';
import { buildContext, DEFAULT_RULES } from '../policy/rules.mjs';
import { OUTCOMES } from './approvalLedger.mjs';
import { ModelPolicyError } from './integration.mjs';

/**
 * The durable shape of one recorded decision. The brief's schema omitted the
 * outcome column — a ledger row that cannot say what was decided is not a
 * ledger — and named the auditor column `by`, which read like a keyword and
 * broke the naming the in-memory entry already established. `decided_by` it
 * is. Everything else is the brief's schema, unchanged.
 *
 * @type {string}
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS approval_ledger (
  decision_id TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL,
  model_id    TEXT NOT NULL,
  outcome     TEXT NOT NULL,
  at          TEXT NOT NULL,
  decided_by  TEXT
);
`;

/**
 * Validate one entry's shape — the same rules the in-memory ledger enforces,
 * re-declared here as a private function rather than shared, because the
 * duplicate check differs: the Map checks its own keys, the table checks its
 * rows. Shape errors are caller errors and are thrown before the policy
 * engine is asked.
 *
 * @param {{ decision_id?: unknown, taskId?: unknown, modelId?: unknown, outcome?: unknown, decided_by?: unknown }} entry
 * @returns {{ decision_id: string, taskId: string, modelId: string, outcome: string, decided_by?: string }}
 */
function requireShape(entry) {
  const keyFields = /** @type {['decision_id', 'taskId', 'modelId']} */ (['decision_id', 'taskId', 'modelId']);
  for (const field of keyFields) {
    if (typeof entry[field] !== 'string' || /** @type {string} */ (entry[field]) === '') {
      throw new StoreError('INVALID_SHAPE', `approval entry needs a non-empty ${field}`, { what: field });
    }
  }
  if (!OUTCOMES.includes(/** @type {string} */ (entry.outcome))) {
    throw new StoreError('INVALID_SHAPE', `approval outcome must be one of: ${OUTCOMES.join(', ')}`, { what: 'outcome' });
  }
  return /** @type {{ decision_id: string, taskId: string, modelId: string, outcome: string, decided_by?: string }} */ (entry);
}

/**
 * One recorded decision, in the shape both ledgers speak.
 *
 * @typedef {{ decision_id: string, taskId: string, modelId: string, outcome: string, at: string, decided_by?: string }} LedgerEntry
 */

/**
 * The gate options every engine-gated write takes.
 *
 * @typedef {{ rules?: import('../policy/rules.mjs').RuleSet, granted_capabilities?: string[] }} GateOptions
 */

/**
 * @typedef {object} PersistentLedger
 * @property {(entry: Omit<LedgerEntry, 'at'>, options?: GateOptions) => LedgerEntry} add
 * @property {() => LedgerEntry[]} list
 * @property {() => void} close
 */

/**
 * Open (and create if needed) a SQLite-backed approval ledger. Writes go
 * through the real engine under the `model.approval.persist` rule (requires
 * `model.admin`) — persistence does not lower the bar, it raises the stakes:
 * a durable audit trail anyone can write is worth less than nothing.
 *
 * The recording time is the ledger's clock, not the caller's, matching the
 * in-memory ledger. Reads are ungated, like every other read of history.
 *
 * @param {string} dbPath
 * @returns {PersistentLedger}
 */
export function createPersistentLedger(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  const selectOne = db.prepare('SELECT decision_id FROM approval_ledger WHERE decision_id = ?');
  const insert = db.prepare(
    'INSERT INTO approval_ledger (decision_id, task_id, model_id, outcome, at, decided_by) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const selectAll = db.prepare(
    'SELECT decision_id, task_id, model_id, outcome, at, decided_by FROM approval_ledger ORDER BY rowid',
  );

  return {
    /**
     * @param {{ decision_id: string, taskId: string, modelId: string, outcome: string, decided_by?: string }} entry
     * @param {{ rules?: import('../policy/rules.mjs').RuleSet, granted_capabilities?: string[] }} [options]
     * @returns {{ decision_id: string, taskId: string, modelId: string, outcome: string, at: string, decided_by?: string }}
     */
    add(entry, options = {}) {
      const clean = requireShape(entry);
      const existing = selectOne.get(clean.decision_id);
      if (existing !== undefined) {
        throw new StoreError('INVALID_SHAPE', `duplicate approval record for decision ${clean.decision_id}`, { what: 'decision_id' });
      }
      const context = buildContext({
        rules: options.rules ?? DEFAULT_RULES,
        tool_id: 'model.approval.persist',
        granted_capabilities: options.granted_capabilities ?? [],
        budget: { exceeded: false },
        approval: { status: null },
        complete: true,
      });
      const decision = decide(
        {
          action: 'model.approval.persist',
          target: clean.decision_id,
          requested_capabilities: ['model.admin'],
          effect_class: 'local_reversible',
          requested_by: 'model-approval-persist',
        },
        context,
      );
      if (!permitsExecution(decision)) throw new ModelPolicyError(decision);
      const at = new Date().toISOString();
      const decidedBy = typeof clean.decided_by === 'string' && clean.decided_by !== '' ? clean.decided_by : null;
      insert.run(clean.decision_id, clean.taskId, clean.modelId, clean.outcome, at, decidedBy);
      /** @type {{ decision_id: string, taskId: string, modelId: string, outcome: string, at: string, decided_by?: string }} */
      const stored = {
        decision_id: clean.decision_id,
        taskId: clean.taskId,
        modelId: clean.modelId,
        outcome: clean.outcome,
        at,
      };
      if (decidedBy !== null) stored.decided_by = decidedBy;
      return stored;
    },

    /**
     * Every persisted decision, in insertion order — the order decisions were
     * recorded is part of the record. Returned as copies: callers read
     * history, they do not edit it.
     *
     * @returns {Array<{ decision_id: string, taskId: string, modelId: string, outcome: string, at: string, decided_by?: string }>}
     */
    list() {
      const rows = /** @type {Array<{ decision_id: string, task_id: string, model_id: string, outcome: string, at: string, decided_by: string | null }>} */ (selectAll.all());
      return rows.map((row) => {
        /** @type {{ decision_id: string, taskId: string, modelId: string, outcome: string, at: string, decided_by?: string }} */
        const entry = {
          decision_id: row.decision_id,
          taskId: row.task_id,
          modelId: row.model_id,
          outcome: row.outcome,
          at: row.at,
        };
        if (row.decided_by !== null) entry.decided_by = row.decided_by;
        return entry;
      });
    },

    /** @returns {void} */
    close() {
      db.close();
    },
  };
}
