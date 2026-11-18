import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const EXT_KINDS = Object.freeze(['skill', 'plugin', 'mcp']);
export const EXT_EFFECT_CLASSES = Object.freeze(['read_only', 'local_reversible', 'external']);
export const EXT_STATES = Object.freeze(['candidate', 'approved', 'active', 'revoked']);

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$|^[a-z0-9]$/;
const ELEVATED_CAPABILITIES = new Set(['process.spawn', 'workspace.write']);

export class ExtError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'ExtError';
    this.code = code;
  }
}

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   version: string,
 *   description: string,
 *   kind: 'skill' | 'plugin' | 'mcp',
 *   effect_class: 'read_only' | 'local_reversible' | 'external',
 *   requested_capabilities: string[],
 *   entry: string
 * }} ExtensionManifest
 */

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   version: string,
 *   kind: 'skill' | 'plugin' | 'mcp',
 *   effect_class: 'read_only' | 'local_reversible' | 'external',
 *   entry: string,
 *   requested_capabilities: string[],
 *   state: 'candidate' | 'approved' | 'active' | 'revoked',
 *   source: string,
 *   approved_by: string | null,
 *   approved_at: string | null,
 *   revoked_by: string | null,
 *   revoked_at: string | null,
 *   revoke_reason: string | null,
 *   created_at: string,
 *   updated_at: string
 * }} ExtensionRecord
 */

/** @param {unknown} value */
function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** @param {unknown} value */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Rejects drive letters (`:`), leading separators, null bytes, percent-encoding,
 * untrimmed whitespace, and `..` segments so a manifest cannot point outside its
 * own extension root.
 *
 * @param {unknown} entry
 * @returns {string | null}
 */
function validateEntry(entry) {
  if (!isNonEmptyString(entry)) return 'entry must be a non-empty string';
  const raw = /** @type {string} */ (entry);
  if (raw !== raw.trim()) return 'entry must not have leading or trailing whitespace';
  if (raw.includes('\0')) return 'entry must not contain null bytes';
  if (raw.includes('%')) return 'entry must not contain percent-encoded characters';
  if (/^[/\\]/.test(raw)) return 'entry must be a relative path';
  if (raw.includes(':')) return 'entry must not contain drive letters or schemes';
  const segments = raw.split(/[/\\]/);
  if (segments.some((seg) => seg !== seg.trim() || seg === '..')) {
    return 'entry must not contain .. or whitespace-padded path segments';
  }
  return null;
}

/**
 * @param {unknown} raw
 * @returns {{ ok: true, manifest: ExtensionManifest } | { ok: false, errors: string[] }}
 */
export function validateManifest(raw) {
  if (!isPlainObject(raw)) {
    return { ok: false, errors: ['manifest must be a non-null plain object'] };
  }

  const obj = /** @type {Record<string, unknown>} */ (raw);
  /** @type {string[]} */
  const errors = [];

  if (typeof obj.id !== 'string' || !ID_PATTERN.test(obj.id)) {
    errors.push('id must be a kebab-case string (1-64 chars, [a-z0-9-])');
  }
  if (!isNonEmptyString(obj.name)) {
    errors.push('name must be a non-empty string');
  }
  if (!isNonEmptyString(obj.version)) {
    errors.push('version must be a non-empty string');
  }
  if (obj.description !== undefined && typeof obj.description !== 'string') {
    errors.push('description must be a string when provided');
  }
  if (typeof obj.kind !== 'string' || !EXT_KINDS.includes(obj.kind)) {
    errors.push(`kind must be one of: ${EXT_KINDS.join(', ')}`);
  }
  if (typeof obj.effect_class !== 'string' || !EXT_EFFECT_CLASSES.includes(obj.effect_class)) {
    errors.push(`effect_class must be one of: ${EXT_EFFECT_CLASSES.join(', ')}`);
  }

  /** @type {string[]} */
  const capabilities = [];
  if (!Array.isArray(obj.requested_capabilities)) {
    errors.push('requested_capabilities must be an array of non-empty strings');
  } else {
    const seen = new Set();
    for (const cap of obj.requested_capabilities) {
      if (!isNonEmptyString(cap) || cap !== cap.trim()) {
        errors.push('requested_capabilities entries must be trimmed non-empty strings');
        break;
      }
      if (!seen.has(cap)) {
        seen.add(cap);
        capabilities.push(cap);
      }
    }
  }

  const entryErr = validateEntry(obj.entry);
  if (entryErr) errors.push(entryErr);

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    manifest: {
      id: /** @type {string} */ (obj.id),
      name: /** @type {string} */ (obj.name),
      version: /** @type {string} */ (obj.version),
      description: typeof obj.description === 'string' ? obj.description : '',
      kind: /** @type {ExtensionManifest['kind']} */ (obj.kind),
      effect_class: /** @type {ExtensionManifest['effect_class']} */ (obj.effect_class),
      requested_capabilities: capabilities,
      entry: /** @type {string} */ (obj.entry),
    },
  };
}

/**
 * @param {unknown} raw
 * @returns {{
 *   id: string,
 *   kind: ExtensionManifest['kind'],
 *   effect_class: ExtensionManifest['effect_class'],
 *   requested_capabilities: string[],
 *   risk_level: 'low' | 'elevated' | 'high'
 * }}
 */
export function inspectPermissions(raw) {
  const checked = validateManifest(raw);
  if (!checked.ok) {
    throw new ExtError('INVALID_MANIFEST', checked.errors.join('; '));
  }
  const { manifest } = checked;

  /** @type {'low' | 'elevated' | 'high'} */
  let riskLevel = 'low';
  if (manifest.effect_class === 'external') {
    riskLevel = 'high';
  } else if (
    manifest.effect_class === 'local_reversible' ||
    manifest.requested_capabilities.some((cap) => ELEVATED_CAPABILITIES.has(cap))
  ) {
    riskLevel = 'elevated';
  }

  return {
    id: manifest.id,
    kind: manifest.kind,
    effect_class: manifest.effect_class,
    requested_capabilities: manifest.requested_capabilities,
    risk_level: riskLevel,
  };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS extensions (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  version           TEXT NOT NULL,
  kind              TEXT NOT NULL,
  effect_class      TEXT NOT NULL,
  entry             TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  state             TEXT NOT NULL,
  source            TEXT NOT NULL,
  approved_by       TEXT,
  approved_at       TEXT,
  revoked_by        TEXT,
  revoked_at        TEXT,
  revoke_reason     TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
`;

/**
 * @param {Record<string, unknown>} row
 * @returns {ExtensionRecord}
 */
function toRecord(row) {
  /** @type {string[]} */
  let caps;
  try {
    caps = /** @type {string[]} */ (JSON.parse(/** @type {string} */ (row.capabilities_json)));
  } catch {
    throw new ExtError('CORRUPT_RECORD', `corrupt capabilities_json for extension ${row.id}`);
  }
  return {
    id: /** @type {string} */ (row.id),
    name: /** @type {string} */ (row.name),
    version: /** @type {string} */ (row.version),
    kind: /** @type {ExtensionRecord['kind']} */ (row.kind),
    effect_class: /** @type {ExtensionRecord['effect_class']} */ (row.effect_class),
    entry: /** @type {string} */ (row.entry),
    requested_capabilities: caps,
    state: /** @type {ExtensionRecord['state']} */ (row.state),
    source: /** @type {string} */ (row.source),
    approved_by: /** @type {string | null} */ (row.approved_by ?? null),
    approved_at: /** @type {string | null} */ (row.approved_at ?? null),
    revoked_by: /** @type {string | null} */ (row.revoked_by ?? null),
    revoked_at: /** @type {string | null} */ (row.revoked_at ?? null),
    revoke_reason: /** @type {string | null} */ (row.revoke_reason ?? null),
    created_at: /** @type {string} */ (row.created_at),
    updated_at: /** @type {string} */ (row.updated_at),
  };
}

/**
 * @param {{ path: string, now?: () => number }} options
 */
export function openExtensionRegistry(options) {
  const path = options.path;
  const now = options.now ?? Date.now;
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = FULL');
  db.exec(SCHEMA);

  const selectById = db.prepare('SELECT * FROM extensions WHERE id = ?');
  const selectAll = db.prepare('SELECT * FROM extensions ORDER BY created_at ASC, id ASC');
  const selectByState = db.prepare('SELECT * FROM extensions WHERE state = ? ORDER BY created_at ASC, id ASC');
  const insertCandidate = db.prepare(
    `INSERT INTO extensions (
       id, name, version, kind, effect_class, entry, capabilities_json,
       state, source, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?, ?)`,
  );
  const updateCandidate = db.prepare(
    `UPDATE extensions
     SET name = ?, version = ?, kind = ?, effect_class = ?, entry = ?,
         capabilities_json = ?, source = ?, updated_at = ?
     WHERE id = ? AND state = 'candidate'`,
  );
  const updateApproved = db.prepare(
    `UPDATE extensions
     SET state = 'approved', approved_by = ?, approved_at = ?, updated_at = ?
     WHERE id = ? AND state = 'candidate'`,
  );
  const updateActive = db.prepare(
    `UPDATE extensions SET state = 'active', updated_at = ? WHERE id = ? AND state = 'approved'`,
  );
  const updateRevoked = db.prepare(
    `UPDATE extensions
     SET state = 'revoked', revoked_by = ?, revoked_at = ?, revoke_reason = ?, updated_at = ?
     WHERE id = ? AND state != 'revoked'`,
  );

  /** @param {string} id */
  function mustExist(id) {
    const row = /** @type {Record<string, unknown> | undefined} */ (selectById.get(id));
    if (!row) throw new ExtError('EXTENSION_NOT_FOUND', `no extension ${id}`);
    return row;
  }

  return {
    /**
     * @param {unknown} rawManifest
     * @param {{ source: string }} opts
     * @returns {ExtensionRecord}
     */
    registerCandidate(rawManifest, opts) {
      if (!opts || !isNonEmptyString(opts.source)) {
        throw new ExtError('INVALID_SOURCE', 'source must be a non-empty string');
      }
      const checked = validateManifest(rawManifest);
      if (!checked.ok) {
        throw new ExtError('INVALID_MANIFEST', checked.errors.join('; '));
      }
      const { manifest } = checked;
      const existing = /** @type {Record<string, unknown> | undefined} */ (selectById.get(manifest.id));

      // Refusing to overwrite active, approved, or revoked rows prevents a
      // re-registration from silently resetting revocation or bypassing approval.
      if (existing && existing.state !== 'candidate') {
        throw new ExtError('EXTENSION_EXISTS', `extension ${manifest.id} already exists in state ${existing.state}`);
      }

      const timestamp = new Date(now()).toISOString();
      const capsJson = JSON.stringify(manifest.requested_capabilities);

      if (existing) {
        updateCandidate.run(
          manifest.name,
          manifest.version,
          manifest.kind,
          manifest.effect_class,
          manifest.entry,
          capsJson,
          opts.source,
          timestamp,
          manifest.id,
        );
      } else {
        insertCandidate.run(
          manifest.id,
          manifest.name,
          manifest.version,
          manifest.kind,
          manifest.effect_class,
          manifest.entry,
          capsJson,
          opts.source,
          timestamp,
          timestamp,
        );
      }

      return toRecord(/** @type {Record<string, unknown>} */ (selectById.get(manifest.id)));
    },

    /**
     * @param {string} id
     * @param {{ approvedBy: string }} opts
     * @returns {ExtensionRecord}
     */
    approve(id, opts) {
      if (!opts || !isNonEmptyString(opts.approvedBy)) {
        throw new ExtError('INVALID_APPROVER', 'approvedBy must be a non-empty string');
      }
      const row = mustExist(id);
      if (row.state !== 'candidate') {
        throw new ExtError('INVALID_STATE', `cannot approve extension ${id} from state ${row.state}`);
      }
      const timestamp = new Date(now()).toISOString();
      const res = updateApproved.run(opts.approvedBy, timestamp, timestamp, id);
      if (res.changes !== 1) {
        throw new ExtError('INVALID_STATE', `concurrent state change while approving ${id}`);
      }
      return toRecord(/** @type {Record<string, unknown>} */ (selectById.get(id)));
    },

    /**
     * @param {string} id
     * @returns {ExtensionRecord}
     */
    activate(id) {
      const row = mustExist(id);
      if (row.state === 'candidate') {
        throw new ExtError('EXTENSION_NOT_APPROVED', `extension ${id} is still a candidate`);
      }
      if (row.state === 'revoked') {
        throw new ExtError('EXTENSION_REVOKED', `extension ${id} has been revoked`);
      }
      if (row.state !== 'approved') {
        throw new ExtError('INVALID_STATE', `cannot activate extension ${id} from state ${row.state}`);
      }
      const timestamp = new Date(now()).toISOString();
      const res = updateActive.run(timestamp, id);
      if (res.changes !== 1) {
        throw new ExtError('INVALID_STATE', `concurrent state change while activating ${id}`);
      }
      return toRecord(/** @type {Record<string, unknown>} */ (selectById.get(id)));
    },

    /**
     * @param {string} id
     * @param {{ revokedBy: string, reason?: string }} opts
     * @returns {ExtensionRecord}
     */
    revoke(id, opts) {
      if (!opts || !isNonEmptyString(opts.revokedBy)) {
        throw new ExtError('INVALID_REVOKER', 'revokedBy must be a non-empty string');
      }
      const row = mustExist(id);
      if (row.state === 'revoked') {
        throw new ExtError('EXTENSION_REVOKED', `extension ${id} is already revoked`);
      }
      const reason = typeof opts.reason === 'string' ? opts.reason : '';
      const timestamp = new Date(now()).toISOString();
      const res = updateRevoked.run(opts.revokedBy, timestamp, reason, timestamp, id);
      if (res.changes !== 1) {
        throw new ExtError('EXTENSION_REVOKED', `extension ${id} was already revoked`);
      }
      return toRecord(/** @type {Record<string, unknown>} */ (selectById.get(id)));
    },

    /**
     * @param {string} id
     * @returns {ExtensionRecord | null}
     */
    get(id) {
      const row = /** @type {Record<string, unknown> | undefined} */ (selectById.get(id));
      return row ? toRecord(row) : null;
    },

    /**
     * @param {{ state?: ExtensionRecord['state'] }} [opts]
     * @returns {ExtensionRecord[]}
     */
    list(opts = {}) {
      const rows = opts.state
        ? /** @type {Record<string, unknown>[]} */ (selectByState.all(opts.state))
        : /** @type {Record<string, unknown>[]} */ (selectAll.all());
      return rows.map(toRecord);
    },

    close() {
      db.close();
    },
  };
}
