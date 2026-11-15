/**
 * @generated
 * @purpose  M-6 DB-backed provider loader: resolve a model binding from a SQLite providers.db
 * @requires Chief-of-Staff
 */
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { ProviderNotFound } from '../provider.mjs';

/** Thrown when the providers database itself is missing — a caller error, caught by callers, not by the policy engine. */
export class ProviderDBNotFound extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'ProviderDBNotFound';
    this.code = 'PROVIDER_DB_NOT_FOUND';
  }
}

/**
 * The binding table: which model id rides on which provider kind, and where
 * its endpoint lives. Deliberately no API-key column — a secret at rest in a
 * plaintext database file is a leak waiting for a backup job. Keys belong in
 * the OS credential store; this scaffold stores bindings only.
 *
 * @type {string}
 */
export const PROVIDER_DB_SCHEMA = `
CREATE TABLE IF NOT EXISTS provider_bindings (
  model_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  endpoint TEXT NOT NULL
);
`;

/**
 * Create the binding table on an open database. Exported so tests and the
 * future CLI build fixtures against the one schema this module actually uses.
 *
 * @param {DatabaseSync} db
 * @returns {void}
 */
export function ensureProviderSchema(db) {
  db.exec(PROVIDER_DB_SCHEMA);
}

/**
 * Resolve a model's binding from a providers.db and return a mock invocation
 * function shaped like the other provider stubs. No network, no keys, no
 * fetch — the milestone proper wires real transports; this scaffold proves
 * the resolution path and the failure modes.
 *
 * Resolution is not authorization: the approval gate still decides whether an
 * invocation may run, and this loader deliberately knows nothing about
 * capabilities. The database is opened read-only — a loader that can create
 * or rewrite its own source of truth is a loader that can be pointed at
 * itself.
 *
 * @param {string} dbPath
 * @param {string} modelId
 * @returns {{ provider: string, endpoint: string, invoke: (prompt: string) => { provider: string, answer: string, echo: string } }}
 */
export function loadProviderFromDb(dbPath, modelId) {
  if (!existsSync(dbPath)) {
    throw new ProviderDBNotFound(`no providers database: ${dbPath}`);
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = /** @type {{ provider: string, endpoint: string } | undefined} */ (
      db.prepare('SELECT provider, endpoint FROM provider_bindings WHERE model_id = ?').get(modelId)
    );
    if (row === undefined) throw new ProviderNotFound(`no provider binding for model: ${modelId}`);
    return {
      provider: row.provider,
      endpoint: row.endpoint,
      invoke: (prompt) => ({ provider: row.provider, answer: 'mock-db-response', echo: prompt }),
    };
  } finally {
    db.close();
  }
}
