import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { StoreError, IntegrityError, StoreLockedError } from '../core/errors.mjs';
import { ulid } from '../core/ids.mjs';
import { canonicalHash } from '../core/json.mjs';
import { requireInteger } from '../core/validate.mjs';
import { SCHEMA_VERSION, validateDraft, toRow, fromRow } from './schema.mjs';
import { claimWriteLock, clearWriterClaim, describeCause, describeWriterClaim, isLockRefusal, releaseWriteLock, writeWriterClaim } from './lock.mjs';

/**
 * The bounded event store.
 *
 * Responsibilities: validate structure, assign sequence, persist, maintain
 * ordering, read, bounded query, integrity verification, recovery.
 * It does not grant permissions, approve tools, decide authorization, execute
 * tools, invoke models, or decide which agents may act. `tools/check/store-boundary.mjs`
 * enforces that boundary mechanically rather than by convention.
 */

const DEFAULT_BUSY_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_QUERY_LIMIT = 1_000;
const DEFAULT_MAX_BATCH = 1_000;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  seq              INTEGER PRIMARY KEY,
  event_id         TEXT    NOT NULL UNIQUE,
  event_type       TEXT    NOT NULL,
  schema_version   INTEGER NOT NULL,
  occurred_at      TEXT    NOT NULL,
  recorded_at      TEXT    NOT NULL,
  session_id       TEXT    NOT NULL,
  task_id          TEXT,
  producer         TEXT    NOT NULL,
  correlation_id   TEXT    NOT NULL,
  causation_id     TEXT,
  payload_text     TEXT    NOT NULL,
  payload_hash     TEXT    NOT NULL,
  redaction_applied INTEGER NOT NULL,
  redaction_rules  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events (session_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_task ON events (task_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_type ON events (event_type, seq);
CREATE INDEX IF NOT EXISTS idx_events_correlation ON events (correlation_id, seq);
`;

/**
 * @typedef {object} OpenOptions
 * @property {string} path absolute path to the database file
 * @property {string} [writerId]
 * @property {number} [lockTimeoutMs]
 * @property {number} [busyTimeoutMs]
 * @property {string} [producer] default producer for drafts that omit one
 * @property {() => number} [now] injectable clock (milliseconds)
 * @property {boolean} [skipLock] test-only; opens without taking the write role
 */

/**
 * @param {OpenOptions} options
 * @returns {import('../core/types.mjs').EventLog}
 */
export function open(options) {
  if (!options || typeof options.path !== 'string' || options.path.length === 0) {
    throw new StoreError('STORE_PATH_REQUIRED', 'open() needs an absolute path', { got: typeof options?.path });
  }
  const dbPath = options.path;
  const now = options.now ?? (() => Date.now());
  const producer = options.producer ?? 'lain.store';
  const maxBatch = DEFAULT_MAX_BATCH;

  mkdirSync(dirname(dbPath), { recursive: true });

  /** @type {Record<string, unknown>} */
  let writer = { writer_id: 'unclaimed', pid: process.pid };
  /** @type {DatabaseSync | null} */
  let db = null;
  let closed = false;
  let holdsWriteLock = false;

  let openPhase = 'connect';
  try {
    db = new DatabaseSync(dbPath);
    // busy_timeout is 0 for the ownership claim: waiting turns a refusal into a
    // silent queue, and a second writer must be told no rather than made to wait.
    db.exec('PRAGMA busy_timeout = 0');
    openPhase = 'pragmas';
    // WAL is what allows a reader to see a consistent snapshot while batches are
    // being committed; every batch is one transaction, which is a correctness
    // requirement rather than an optimisation.
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = FULL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA journal_size_limit = 67108864');
    openPhase = 'schema';
    db.exec(SCHEMA_SQL);

    const existing = readMetaNumber(db, 'store_schema_version');
    if (existing === null) {
      writeMeta(db, 'store_schema_version', String(SCHEMA_VERSION));
      writeMeta(db, 'created_at', new Date(now()).toISOString());
    } else if (existing !== SCHEMA_VERSION) {
      throw new StoreError('SCHEMA_MISMATCH', `store schema ${existing} is not supported by this build (expects ${SCHEMA_VERSION})`, {
        found: existing,
        expected: SCHEMA_VERSION,
      });
    }
    openPhase = 'meta';
    writeMeta(db, 'last_opened_at', new Date(now()).toISOString());

    // Ownership is taken after the schema exists and is then held for the whole
    // session, so there is no window in which two processes may write.
    if (!options.skipLock) {
      openPhase = 'claim-lock';
      const claim = claimWriteLock(db, dbPath);
      if (!claim.acquired) {
        throw new StoreLockedError('STORE_LOCKED', `another process holds the store's write lock (${claim.cause})`, {
          dbPath,
          phase: claim.phase,
          cause: claim.cause,
          claimed_by: claim.claimed_by,
          mechanism: claim.mechanism,
          note: 'refused by SQLite, not by reading a metadata file',
        });
      }
      holdsWriteLock = true;
      writer = writeWriterClaim(dbPath, {
        writerId: options.writerId ?? `w_${process.pid}_${now().toString(36)}`,
      });
    } else {
      writer = { writer_id: 'lock-skipped', pid: process.pid, mechanism: 'none' };
    }
  } catch (err) {
    if (holdsWriteLock && db) releaseWriteLock(db);
    if (db) {
      try {
        db.close();
      } catch {
        /* nothing further to do */
      }
    }
    // A locked or busy database is the single-writer guarantee doing its job,
    // whichever statement happened to notice first. Mapping it here means the
    // refusal has one error type regardless of the phase that observed it.
    if (isLockRefusal(err)) {
      throw new StoreLockedError('STORE_LOCKED', `another process holds the store's write lock (${describeCause(err)})`, {
        dbPath,
        phase: openPhase,
        cause: describeCause(err),
        claimed_by: describeWriterClaim(dbPath),
        mechanism: 'sqlite-write-lock',
        note: 'refused by SQLite, not by reading a metadata file',
      });
    }
    throw err;
  }

  /** @param {Record<string, unknown>} row */
  function insertRow(row) {
    if (!db) throw new StoreError('STORE_CLOSED', 'the store is closed');
    db.prepare(
      `INSERT INTO events (
         seq, event_id, event_type, schema_version, occurred_at, recorded_at,
         session_id, task_id, producer, correlation_id, causation_id,
         payload_text, payload_hash, redaction_applied, redaction_rules
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      /** @type {number} */ (row.seq),
      /** @type {string} */ (row.event_id),
      /** @type {string} */ (row.event_type),
      /** @type {number} */ (row.schema_version),
      /** @type {string} */ (row.occurred_at),
      /** @type {string} */ (row.recorded_at),
      /** @type {string} */ (row.session_id),
      /** @type {string | null} */ (row.task_id),
      /** @type {string} */ (row.producer),
      /** @type {string} */ (row.correlation_id),
      /** @type {string | null} */ (row.causation_id),
      /** @type {string} */ (row.payload_text),
      /** @type {string} */ (row.payload_hash),
      /** @type {number} */ (row.redaction_applied),
      /** @type {string} */ (row.redaction_rules),
    );
  }

  /** @returns {number} */
  function nextSeq() {
    if (!db) throw new StoreError('STORE_CLOSED', 'the store is closed');
    const row = db.prepare('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM events').get();
    return Number(/** @type {any} */ (row).max_seq) + 1;
  }

  /** @param {unknown[]} drafts */
  function appendMany(drafts) {
    if (!db) throw new StoreError('STORE_CLOSED', 'the store is closed');
    if (!Array.isArray(drafts)) {
      throw new StoreError('INVALID_BATCH', 'append() takes an array of event drafts', { actual: typeof drafts });
    }
    if (drafts.length === 0) {
      throw new StoreError('EMPTY_BATCH', 'a batch must contain at least one event');
    }
    if (drafts.length > maxBatch) {
      throw new StoreError('BATCH_TOO_LARGE', `a batch may contain at most ${maxBatch} events`, {
        size: drafts.length,
        ceiling: maxBatch,
      });
    }

    // Everything is validated before anything is written, so a batch that fails
    // validation leaves the store exactly as it was and never partially applies.
    const validated = drafts.map((draft) => validateDraft(draft, { defaultProducer: producer }));
    const batchId = drafts.length === 1 && typeof (/** @type {any} */ (drafts[0])?.batch_id) === 'string'
      ? /** @type {string} */ (/** @type {any} */ (drafts[0]).batch_id)
      : ulid(now());
    const recordedAt = new Date(now()).toISOString();

    if (!options.skipLock && !holdsWriteLock) {
      throw new StoreError('WRITER_NOT_OWNED', 'this handle does not hold the write lock, so it may not append', { batch_id: batchId });
    }

    try {
      const first = nextSeq();
      validated.forEach((item, index) => {
        insertRow(toRow(item, { seq: first + index, recorded_at: recordedAt }));
      });
      db.exec('COMMIT');
      // The lock is re-taken immediately after the commit, synchronously, with no
      // await in between. That is NOT a continuous-ownership guarantee: across
      // processes the gap between COMMIT and the next BEGIN IMMEDIATE is real and
      // a competing writer can win it (measured 2026-11-08 — four of four
      // competitors did, while this writer was mid-session). The response is
      // fail-closed: the batch that committed stays durable, and this handle stops
      // being a writer rather than continuing without ownership.
      if (!options.skipLock) {
        const reacquisition = claimWriteLock(db, dbPath);
        if (!reacquisition.acquired) {
          holdsWriteLock = false;
          // The batch is committed and therefore durable; what is lost is this
          // handle's right to write again. Closing it is the honest response:
          // continuing would leave a writer that no longer owns the store.
          throw new StoreLockedError('STORE_LOCK_LOST', 'the write lock could not be re-taken after commit; this writer may not append again', {
            batch_id: batchId,
            committed_through_seq: first + validated.length - 1,
            cause: reacquisition.cause,
            claimed_by: reacquisition.claimed_by,
          });
        }
      }
      return {
        batch_id: batchId,
        from_seq: first,
        to_seq: first + validated.length - 1,
        count: validated.length,
        recorded_at: recordedAt,
        redacted_count: validated.filter((item) => item.redaction.applied).length,
      };
    } catch (err) {
      if (db) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* the transaction is already gone */
        }
      }
      throw err;
    }
  }

  /**
   * @param {object} [query]
   * @returns {Record<string, unknown>[]}
   */
  function read(query = {}) {
    if (!db) throw new StoreError('STORE_CLOSED', 'the store is closed');
    const q = /** @type {Record<string, unknown>} */ (query);
    const limit = requireInteger(q.limit ?? 100, 'limit', { min: 1, max: DEFAULT_MAX_QUERY_LIMIT });
    /** @type {string[]} */
    const where = [];
    /** @type {unknown[]} */
    const params = [];
    if (q.session_id !== undefined) {
      where.push('session_id = ?');
      params.push(q.session_id);
    }
    if (q.task_id !== undefined) {
      where.push('task_id = ?');
      params.push(q.task_id);
    }
    if (q.event_type !== undefined) {
      where.push('event_type = ?');
      params.push(q.event_type);
    }
    if (q.correlation_id !== undefined) {
      where.push('correlation_id = ?');
      params.push(q.correlation_id);
    }
    if (q.from_seq !== undefined) {
      where.push('seq >= ?');
      params.push(requireInteger(q.from_seq, 'from_seq', { min: 1 }));
    }
    if (q.to_seq !== undefined) {
      where.push('seq <= ?');
      params.push(requireInteger(q.to_seq, 'to_seq', { min: 1 }));
    }
    const sql = `SELECT * FROM events ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY seq ASC LIMIT ?`;
    const rows = db.prepare(sql).all(.../** @type {any[]} */ (params), limit);
    return rows.map((row) => fromRow(/** @type {Record<string, unknown>} */ (row)));
  }

  /** @param {string} eventId */
  function get(eventId) {
    if (!db) throw new StoreError('STORE_CLOSED', 'the store is closed');
    const row = db.prepare('SELECT * FROM events WHERE event_id = ?').get(eventId);
    return row === undefined ? null : fromRow(/** @type {Record<string, unknown>} */ (row));
  }

  /** @returns {{count: number, max_seq: number, schema_version: number}} */
function stats() {
    if (!db) throw new StoreError('STORE_CLOSED', 'the store is closed');
    const row = /** @type {any} */ (db.prepare('SELECT COUNT(*) AS count, COALESCE(MAX(seq), 0) AS max_seq FROM events').get());
    return { count: Number(row.count), max_seq: Number(row.max_seq), schema_version: readMetaNumber(db, 'store_schema_version') ?? SCHEMA_VERSION };
  }

  /**
   * @param {{deep?: boolean}} [opts]
   */
  function verify(opts = {}) {
    if (!db) throw new StoreError('STORE_CLOSED', 'the store is closed');
    /** @type {{name: string, ok: boolean, detail?: string}[]} */
    const checks = [];
    const pragma = /** @type {any} */ (db.prepare('PRAGMA integrity_check').get());
    // The pragma returns a single column named `integrity_check` whose value is
    // the string 'ok' when clean, or one row per problem when not.
    const pragmaValue = pragma?.integrity_check;
    checks.push({ name: 'sqlite_integrity_check', ok: pragmaValue === 'ok', detail: String(pragmaValue) });

    const seqRows = /** @type {any[]} */ (db.prepare('SELECT seq FROM events ORDER BY seq ASC').all());
    let contiguous = true;
    let expected = 1;
    for (const row of seqRows) {
      if (Number(row.seq) !== expected) {
        contiguous = false;
        break;
      }
      expected += 1;
    }
    checks.push({ name: 'sequence_contiguous', ok: contiguous, detail: `${seqRows.length} rows from 1` });

    let hashMismatch = 0;
    if (opts.deep !== false) {
      const rows = /** @type {any[]} */ (db.prepare('SELECT seq, event_id, payload_text, payload_hash FROM events ORDER BY seq ASC').all());
      for (const row of rows) {
        let parsed;
        try {
          parsed = JSON.parse(row.payload_text);
        } catch {
          hashMismatch += 1;
          continue;
        }
        if (canonicalHash(parsed) !== row.payload_hash) hashMismatch += 1;
      }
      checks.push({ name: 'payload_hashes', ok: hashMismatch === 0, detail: `${hashMismatch} mismatched of ${rows.length}` });
    }

    const ok = checks.every((item) => item.ok);
    return { ok, checks };
  }

  /**
   * Copy the store to `target.path` using SQLite's own online-backup API.
   *
   * `backup()` is deliberately asynchronous and holds no write transaction of
   * its own: the source database stays open and usable, and a concurrent reader
   * sees a consistent snapshot.
   *
   * Known limitation, stated rather than hidden: node:sqlite's backup job
   * cannot run while this process holds the long-lived `BEGIN IMMEDIATE` that
   * makes it the single writer — measured, it rejects with errcode 0 and
   * errstr "not an error" — so the write lock is released for the duration of
   * the copy and re-taken immediately afterwards with `claimWriteLock`, which
   * fails loudly if another process became the writer during that window. The
   * window is therefore a real (if small) gap in single-writer continuity, and
   * it exists only while an explicit backup is running.
   * @param {{path: string}} target
   * @returns {Promise<{path: string, taken_at: string, pages: number, lock_reacquired: boolean}>}
   */
  async function backup(target) {
    if (!db) throw new StoreError('STORE_CLOSED', 'the store is closed');
    if (typeof target?.path !== 'string' || target.path.length === 0) {
      throw new StoreError('BACKUP_PATH_REQUIRED', 'backup() needs a destination path');
    }
    const live = db;
    mkdirSync(dirname(target.path), { recursive: true });
    const hadLock = holdsWriteLock;
    if (hadLock) {
      releaseWriteLock(live);
      holdsWriteLock = false;
    }
    try {
      const pages = await sqliteBackup(live, target.path);
      let reacquired = false;
      if (hadLock) {
        const reclaimed = claimWriteLock(live, dbPath);
        if (!reclaimed.acquired) {
          throw new StoreLockedError('STORE_LOCK_LOST', 'the write lock could not be re-taken after a backup', {
            cause: reclaimed.cause,
            claimed_by: reclaimed.claimed_by,
          });
        }
        holdsWriteLock = true;
        reacquired = true;
      }
      return { path: target.path, taken_at: new Date(now()).toISOString(), pages, lock_reacquired: reacquired };
    } finally {
      // If the copy threw, ownership must still be re-established: the store is
      // not usable as a writer without it, and silent loss would be worse than a
      // loud failure.
      if (hadLock && !holdsWriteLock && db) {
        const reclaimed = claimWriteLock(db, dbPath);
        holdsWriteLock = reclaimed.acquired;
      }
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    if (db) {
      if (holdsWriteLock) releaseWriteLock(db);
      try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch {
        /* a checkpoint failure must not prevent closing */
      }
      try {
        db.close();
      } catch {
        /* already closed */
      }
      db = null;
    }
    holdsWriteLock = false;
    if (!options.skipLock) clearWriterClaim(dbPath);
  }

  return {
    path: dbPath,
    writer,
    schema_version: SCHEMA_VERSION,
    /** True while this handle holds the store's write role. */
    get holds_write_lock() {
      return holdsWriteLock;
    },
    append: appendMany,
    read,
    get,
    stats,
    verify,
    backup,
    close,
    /**
     * Append exactly one event and return its stored record.
     * @param {string} eventType @param {Record<string, unknown>} payload @param {Record<string, unknown>} [extra]
     */
    record(eventType, payload, extra = {}) {
      const result = appendMany([{ event_id: ulid(now()), event_type: eventType, occurred_at: new Date(now()).toISOString(), payload, ...extra }]);
      return { ...result, seq: result.from_seq };
    },
  };
}

/**
 * @param {DatabaseSync} db
 * @param {string} key
 * @returns {number | null}
 */
function readMetaNumber(db, key) {
  const row = /** @type {any} */ (db.prepare('SELECT value FROM meta WHERE key = ?').get(key));
  if (row === undefined) return null;
  const n = Number(row.value);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {DatabaseSync} db
 * @param {string} key
 * @param {string} value
 */
function writeMeta(db, key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

/**
 * Inspect a store without opening it for writing. Used by recovery tooling and
 * by tests that must not take ownership.
 *
 * @param {string} dbPath
 */
export function inspect(dbPath) {
  const exists = existsSync(dbPath);
  let readable = false;
  let stats = null;
  let error = null;
  if (exists) {
    let db = null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const row = /** @type {any} */ (db.prepare('SELECT COUNT(*) AS count, COALESCE(MAX(seq), 0) AS max_seq FROM events').get());
      stats = { count: Number(row.count), max_seq: Number(row.max_seq) };
      readable = true;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      if (db) {
        try {
          db.close();
        } catch {
          /* nothing further */
        }
      }
    }
  }
  return { path: dbPath, exists, readable, stats, error, writer_claim: describeWriterClaim(dbPath) };
}

export { IntegrityError };
