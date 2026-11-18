import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ulid } from '../core/ids.mjs';
import { canonicalHash, canonicalJson } from '../core/json.mjs';
import { requireInteger, requireRecord, requireString } from '../core/validate.mjs';
import { findResidualSecrets, redactValue, StoreError } from '../store/redact.mjs';

export const MEMORY_KINDS = Object.freeze([
  'fact',
  'decision',
  'preference',
  'procedure',
  'entity',
]);

export const MEMORY_TRUST_LEVELS = Object.freeze(['trusted', 'untrusted']);

const MAX_NEIGHBOR_DEPTH = 3;
const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 100;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  kind TEXT NOT NULL,
  trust TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  superseded_by TEXT,
  content_hash TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(id UNINDEXED, title, content);
CREATE TABLE IF NOT EXISTS memory_edges (
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  source TEXT NOT NULL,
  trust TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (from_id, to_id, relation)
);
CREATE INDEX IF NOT EXISTS idx_memories_superseded ON memories(superseded_by);
CREATE INDEX IF NOT EXISTS idx_memories_trust ON memories(trust);
CREATE INDEX IF NOT EXISTS idx_edges_to ON memory_edges(to_id);
`;

/**
 * @typedef {'fact' | 'decision' | 'preference' | 'procedure' | 'entity'} MemoryKind
 * @typedef {'trusted' | 'untrusted'} MemoryTrust
 *
 * @typedef {object} MemoryRecord
 * @property {string} id
 * @property {string} title
 * @property {string} content
 * @property {MemoryKind} kind
 * @property {MemoryTrust} trust
 * @property {string} source
 * @property {string} created_at
 * @property {string} updated_at
 * @property {string | null} superseded_by
 * @property {string} content_hash
 *
 * @typedef {object} MemoryEdge
 * @property {string} from_id
 * @property {string} to_id
 * @property {string} relation
 * @property {string} source
 * @property {MemoryTrust} trust
 * @property {string} created_at
 *
 * @typedef {object} MemoryInput
 * @property {string} [id]
 * @property {string} title
 * @property {string} content
 * @property {MemoryKind} [kind]
 * @property {MemoryTrust} [trust]
 * @property {string} source
 */

/**
 * @param {unknown} value
 * @param {string} what
 * @returns {string}
 */
function requireNonBlankString(value, what, max = 4096) {
  const str = requireString(value, what, { min: 1, max });
  if (str.trim().length === 0) {
    throw new StoreError('INVALID_SHAPE', `${what} must not be blank`, { what });
  }
  return str;
}

/**
 * @param {unknown} value
 * @returns {MemoryKind}
 */
function parseKind(value) {
  const kind = value ?? 'fact';
  if (typeof kind !== 'string' || !MEMORY_KINDS.includes(/** @type {MemoryKind} */ (kind))) {
    throw new StoreError('INVALID_MEMORY_KIND', `kind must be one of ${MEMORY_KINDS.join(', ')}`, {
      kind,
    });
  }
  return /** @type {MemoryKind} */ (kind);
}

/**
 * @param {unknown} value
 * @returns {MemoryTrust}
 */
function parseTrust(value) {
  const trust = value ?? 'untrusted';
  if (typeof trust !== 'string' || !MEMORY_TRUST_LEVELS.includes(/** @type {MemoryTrust} */ (trust))) {
    throw new StoreError('INVALID_MEMORY_TRUST', `trust must be one of ${MEMORY_TRUST_LEVELS.join(', ')}`, {
      trust,
    });
  }
  return /** @type {MemoryTrust} */ (trust);
}

/**
 * Quote each whitespace-separated token so punctuation like '-' or ':' does not
 * trigger FTS5 operator syntax errors.
 *
 * @param {string} query
 * @returns {string}
 */
function toFtsQuery(query) {
  const tokens = query
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => `"${t.replaceAll('"', '""')}"`);
  return tokens.join(' ');
}

/**
 * Validate, redact, and reject any record whose serialized form still matches
 * a secret shape. `redactValue` covers `title` and `content`, so a secret in
 * `source` (or anything redaction missed) trips the backstop and fails closed.
 *
 * @param {unknown} input
 * @returns {{ id: string, title: string, content: string, kind: MemoryKind, trust: MemoryTrust, source: string, contentHash: string }}
 */
function prepareMemoryInput(input) {
  const record = requireRecord(input, 'memory');
  const id = record.id === undefined ? ulid() : requireNonBlankString(record.id, 'id', 200);
  const title = requireNonBlankString(record.title, 'title', 1000);
  const content = requireNonBlankString(record.content, 'content', 1_000_000);
  const source = requireNonBlankString(record.source, 'source', 500);
  const kind = parseKind(record.kind);
  const trust = parseTrust(record.trust);

  const redacted = /** @type {{ title: string, content: string }} */ (redactValue({ title, content }));
  const serialized = canonicalJson({
    id,
    title: redacted.title,
    content: redacted.content,
    kind,
    source,
  });
  const residual = findResidualSecrets(serialized);
  if (residual.length > 0) {
    throw new StoreError('SECRET_REFUSED', 'memory payload still matches a known secret shape after redaction', {
      patterns: residual.map((hit) => hit.name),
    });
  }

  return {
    id,
    title: redacted.title,
    content: redacted.content,
    kind,
    trust,
    source,
    contentHash: canonicalHash({ title: redacted.title, content: redacted.content, kind }),
  };
}

/**
 * Open (or create) a SQLite-backed memory and knowledge graph store.
 *
 * @param {{ path: string }} options
 */
export function openMemoryStore(options) {
  if (!options || typeof options.path !== 'string' || options.path.trim().length === 0) {
    throw new StoreError('STORE_PATH_REQUIRED', 'openMemoryStore() requires a database path');
  }
  const dbPath = options.path;
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA_SQL);

  let closed = false;

  function assertOpen() {
    if (closed) {
      throw new StoreError('STORE_CLOSED', 'memory store is closed');
    }
  }

  /**
   * @template T
   * @param {() => T} fn
   * @returns {T}
   */
  function withTransaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Ignore rollback failure so the original error surfaces.
      }
      throw err;
    }
  }

  const selectById = db.prepare(`
    SELECT id, title, content, kind, trust, source, created_at, updated_at, superseded_by, content_hash
    FROM memories
    WHERE id = ?
  `);

  const insertMemory = db.prepare(`
    INSERT INTO memories (id, title, content, kind, trust, source, created_at, updated_at, superseded_by, content_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
  `);

  const updateMemory = db.prepare(`
    UPDATE memories
    SET title = ?, content = ?, kind = ?, trust = ?, source = ?, updated_at = ?, content_hash = ?
    WHERE id = ?
  `);

  const deleteFts = db.prepare('DELETE FROM memories_fts WHERE id = ?');
  const insertFts = db.prepare('INSERT INTO memories_fts (id, title, content) VALUES (?, ?, ?)');

  const searchStmt = db.prepare(`
    SELECT m.id, m.title, m.content, m.kind, m.trust, m.source, m.created_at, m.updated_at, m.superseded_by, m.content_hash
    FROM memories_fts f
    JOIN memories m ON m.id = f.id
    WHERE memories_fts MATCH ?
      AND m.superseded_by IS NULL
      AND (? = 1 OR m.trust = 'trusted')
    ORDER BY bm25(memories_fts), m.updated_at DESC
    LIMIT ?
  `);

  const markSuperseded = db.prepare('UPDATE memories SET superseded_by = ?, updated_at = ? WHERE id = ?');
  const promoteStmt = db.prepare("UPDATE memories SET trust = 'trusted', updated_at = ? WHERE id = ?");
  const selectSupersedes = db.prepare('SELECT id FROM memories WHERE superseded_by = ? ORDER BY created_at ASC, id ASC');

  const upsertEdge = db.prepare(`
    INSERT OR REPLACE INTO memory_edges (from_id, to_id, relation, source, trust, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const selectAdjacentEdges = db.prepare(`
    SELECT from_id, to_id, relation, source, trust, created_at
    FROM memory_edges
    WHERE (from_id = ? OR to_id = ?)
      AND (? = 1 OR trust = 'trusted')
    ORDER BY created_at ASC, from_id ASC, to_id ASC, relation ASC
  `);

  /**
   * @param {string} id
   * @returns {MemoryRecord | null}
   */
  function get(id) {
    assertOpen();
    const cleanId = requireNonBlankString(id, 'id', 200);
    const row = /** @type {MemoryRecord | undefined} */ (selectById.get(cleanId));
    return row ?? null;
  }

  /**
   * @param {MemoryInput} input
   * @returns {MemoryRecord}
   */
  function remember(input) {
    assertOpen();
    const prepared = prepareMemoryInput(input);
    const now = new Date().toISOString();

    return withTransaction(() => {
      const existing = /** @type {MemoryRecord | undefined} */ (selectById.get(prepared.id));
      if (existing) {
        // Untrusted records can only be promoted via promote({ approvedBy }).
        const nextTrust = existing.trust === 'untrusted' ? 'untrusted' : prepared.trust;
        updateMemory.run(
          prepared.title,
          prepared.content,
          prepared.kind,
          nextTrust,
          prepared.source,
          now,
          prepared.contentHash,
          prepared.id,
        );
        deleteFts.run(prepared.id);
        insertFts.run(prepared.id, prepared.title, prepared.content);
      } else {
        insertMemory.run(
          prepared.id,
          prepared.title,
          prepared.content,
          prepared.kind,
          prepared.trust,
          prepared.source,
          now,
          now,
          prepared.contentHash,
        );
        insertFts.run(prepared.id, prepared.title, prepared.content);
      }
      return /** @type {MemoryRecord} */ (selectById.get(prepared.id));
    });
  }

  /**
   * @param {string} query
   * @param {{ limit?: number, includeUntrusted?: boolean }} [opts]
   * @returns {MemoryRecord[]}
   */
  function search(query, opts = {}) {
    assertOpen();
    const rawQuery = requireString(query, 'query', { min: 1, max: 1000 });
    const ftsQuery = toFtsQuery(rawQuery);
    if (ftsQuery.length === 0) return [];

    const limit = requireInteger(opts.limit ?? DEFAULT_SEARCH_LIMIT, 'limit', {
      min: 1,
      max: MAX_SEARCH_LIMIT,
    });
    const includeUntrusted = opts.includeUntrusted === true ? 1 : 0;

    return /** @type {MemoryRecord[]} */ (searchStmt.all(ftsQuery, includeUntrusted, limit));
  }

  /**
   * @param {string} oldId
   * @param {MemoryInput} nextRecord
   * @returns {{ superseded: MemoryRecord, current: MemoryRecord }}
   */
  function supersede(oldId, nextRecord) {
    assertOpen();
    const cleanOldId = requireNonBlankString(oldId, 'oldId', 200);
    const prepared = prepareMemoryInput(nextRecord);
    if (prepared.id === cleanOldId) {
      throw new StoreError('INVALID_SHAPE', 'superseding record must have a distinct id', { id: prepared.id });
    }
    const now = new Date().toISOString();

    return withTransaction(() => {
      const old = /** @type {MemoryRecord | undefined} */ (selectById.get(cleanOldId));
      if (!old) {
        throw new StoreError('NOT_FOUND', `memory ${cleanOldId} not found`, { id: cleanOldId });
      }
      if (old.superseded_by !== null) {
        throw new StoreError('ALREADY_SUPERSEDED', `memory ${cleanOldId} is already superseded`, {
          id: cleanOldId,
          superseded_by: old.superseded_by,
        });
      }
      if (selectById.get(prepared.id)) {
        throw new StoreError('DUPLICATE_ID', `memory ${prepared.id} already exists`, { id: prepared.id });
      }

      insertMemory.run(
        prepared.id,
        prepared.title,
        prepared.content,
        prepared.kind,
        prepared.trust,
        prepared.source,
        now,
        now,
        prepared.contentHash,
      );
      insertFts.run(prepared.id, prepared.title, prepared.content);
      markSuperseded.run(prepared.id, now, cleanOldId);

      return {
        superseded: /** @type {MemoryRecord} */ (selectById.get(cleanOldId)),
        current: /** @type {MemoryRecord} */ (selectById.get(prepared.id)),
      };
    });
  }

  /**
   * @param {string} id
   * @param {{ approvedBy: string }} opts
   * @returns {MemoryRecord}
   */
  function promote(id, opts) {
    assertOpen();
    const cleanId = requireNonBlankString(id, 'id', 200);
    const options = requireRecord(opts, 'promote options');
    if (typeof options.approvedBy !== 'string' || options.approvedBy.trim().length === 0) {
      throw new StoreError('APPROVAL_REQUIRED', 'promote() requires a non-empty approvedBy');
    }

    return withTransaction(() => {
      const existing = /** @type {MemoryRecord | undefined} */ (selectById.get(cleanId));
      if (!existing) {
        throw new StoreError('NOT_FOUND', `memory ${cleanId} not found`, { id: cleanId });
      }
      if (existing.trust !== 'trusted') {
        promoteStmt.run(new Date().toISOString(), cleanId);
      }
      return /** @type {MemoryRecord} */ (selectById.get(cleanId));
    });
  }

  /**
   * @param {string} fromId
   * @param {string} toId
   * @param {string} relation
   * @param {{ source: string, trust?: MemoryTrust }} opts
   * @returns {MemoryEdge}
   */
  function link(fromId, toId, relation, opts) {
    assertOpen();
    const cleanFrom = requireNonBlankString(fromId, 'fromId', 200);
    const cleanTo = requireNonBlankString(toId, 'toId', 200);
    const cleanRelation = requireNonBlankString(relation, 'relation', 200);
    const options = requireRecord(opts, 'link options');
    const source = requireNonBlankString(options.source, 'source', 500);
    const trust = parseTrust(options.trust);
    const now = new Date().toISOString();

    return withTransaction(() => {
      if (!selectById.get(cleanFrom)) {
        throw new StoreError('NOT_FOUND', `memory ${cleanFrom} not found`, { id: cleanFrom });
      }
      if (!selectById.get(cleanTo)) {
        throw new StoreError('NOT_FOUND', `memory ${cleanTo} not found`, { id: cleanTo });
      }
      upsertEdge.run(cleanFrom, cleanTo, cleanRelation, source, trust, now);
      return {
        from_id: cleanFrom,
        to_id: cleanTo,
        relation: cleanRelation,
        source,
        trust,
        created_at: now,
      };
    });
  }

  /**
   * @param {string} id
   * @param {{ depth?: number, includeUntrusted?: boolean }} [opts]
   * @returns {{ root: MemoryRecord | null, nodes: MemoryRecord[], edges: MemoryEdge[] }}
   */
  function neighbors(id, opts = {}) {
    assertOpen();
    const cleanId = requireNonBlankString(id, 'id', 200);
    const depth = requireInteger(opts.depth ?? 1, 'depth', { min: 1, max: MAX_NEIGHBOR_DEPTH });
    const includeUntrusted = opts.includeUntrusted === true;
    const includeUntrustedFlag = includeUntrusted ? 1 : 0;

    const root = /** @type {MemoryRecord | undefined} */ (selectById.get(cleanId));
    if (!root || (!includeUntrusted && root.trust !== 'trusted')) {
      return { root: null, nodes: [], edges: [] };
    }

    /** @type {Set<string>} */
    const visitedNodes = new Set([cleanId]);
    /** @type {Map<string, MemoryEdge>} */
    const seenEdges = new Map();
    /** @type {MemoryRecord[]} */
    const nodes = [];
    /** @type {string[]} */
    let frontier = [cleanId];

    for (let hop = 0; hop < depth && frontier.length > 0; hop += 1) {
      /** @type {string[]} */
      const nextFrontier = [];
      for (const currentId of frontier) {
        const adjacent = /** @type {MemoryEdge[]} */ (selectAdjacentEdges.all(currentId, currentId, includeUntrustedFlag));
        for (const edge of adjacent) {
          const otherId = edge.from_id === currentId ? edge.to_id : edge.from_id;
          const otherNode = /** @type {MemoryRecord | undefined} */ (selectById.get(otherId));
          if (!otherNode || (!includeUntrusted && otherNode.trust !== 'trusted')) {
            continue;
          }
          const edgeKey = `${edge.from_id}\0${edge.to_id}\0${edge.relation}`;
          if (!seenEdges.has(edgeKey)) {
            seenEdges.set(edgeKey, edge);
          }
          if (!visitedNodes.has(otherId)) {
            visitedNodes.add(otherId);
            nodes.push(otherNode);
            nextFrontier.push(otherId);
          }
        }
      }
      frontier = nextFrontier;
    }

    return {
      root,
      nodes,
      edges: Array.from(seenEdges.values()),
    };
  }

  /**
   * @param {string} id
   * @returns {{ id: string, source: string, trust: MemoryTrust, created_at: string, updated_at: string, superseded_by: string | null, supersedes: string[] } | null}
   */
  function provenance(id) {
    assertOpen();
    const record = get(id);
    if (!record) return null;
    const rows = /** @type {{ id: string }[]} */ (selectSupersedes.all(record.id));
    return {
      id: record.id,
      source: record.source,
      trust: record.trust,
      created_at: record.created_at,
      updated_at: record.updated_at,
      superseded_by: record.superseded_by,
      supersedes: rows.map((row) => row.id),
    };
  }

  function close() {
    if (!closed) {
      db.close();
      closed = true;
    }
  }

  return {
    remember,
    get,
    search,
    supersede,
    promote,
    link,
    neighbors,
    provenance,
    close,
  };
}
