import { closeSync, existsSync, fsyncSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';

/**
 * Writer ownership: what actually enforces it, and what is only a label.
 *
 * MEASURED 2026-11-08 on this machine (Node 24.21.0, Windows 11 26200):
 *   - `openSync(path, 'r+')` does NOT give an exclusive handle. A second process
 *     opened the same lock file successfully while the first still held it, so a
 *     file-existence or file-handle protocol alone cannot enforce a single writer.
 *   - `fs.flockSync` does not exist in this Node build (and `fs.constants.LOCK_EX`
 *     is undefined), so advisory locking is not an available second mechanism.
 *   - `BEGIN IMMEDIATE` DOES exclude: with one connection holding a write
 *     transaction, a second connection's `BEGIN IMMEDIATE` fails with
 *     "database is locked", and succeeds again after the first commits.
 *
 * Therefore ownership is enforced by SQLite's own write lock, and the sidecar
 * files below are diagnostics only. They exist to explain a refusal to a human
 * and are never consulted when deciding who owns the store. That distinction is
 * deliberate: a PID in a text file can be stale, reused, or hand-edited, so it
 * must not be able to grant write access.
 */

/** @param {string} dbPath */
export function writerInfoPathFor(dbPath) {
  return `${dbPath}.writer.json`;
}

/** @param {string} dbPath */
export function lockPathFor(dbPath) {
  return `${dbPath}.writer.lock`;
}

/**
 * Record who claims the store, for diagnostics. Writing this file grants nothing.
 *
 * @param {string} dbPath
 * @param {{writerId: string, pid?: number}} opts
 * @returns {Record<string, unknown>}
 */
export function writeWriterClaim(dbPath, opts) {
  const claim = {
    writer_id: opts.writerId,
    pid: opts.pid ?? process.pid,
    host: hostname(),
    started_at: new Date().toISOString(),
    mechanism: 'sqlite-begin-immediate',
    note: 'advisory only: the SQLite write lock is the authority, not this file',
  };
  try {
    writeFileSync(writerInfoPathFor(dbPath), `${JSON.stringify(claim, null, 2)}\n`, 'utf8');
    writeFileSync(lockPathFor(dbPath), `${claim.writer_id}\n`, 'utf8');
  } catch {
    // A failed diagnostic write must not fail the store: the guarantee does not
    // depend on it, and refusing to open because a label could not be written
    // would make the label load-bearing by accident.
  }
  return claim;
}

/** @param {string} dbPath */
export function clearWriterClaim(dbPath) {
  for (const path of [writerInfoPathFor(dbPath), lockPathFor(dbPath)]) {
    try {
      unlinkSync(path);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Diagnostics-only view of who claims the store. Never used to grant or refuse
 * ownership.
 *
 * @param {string} dbPath
 * @returns {Record<string, unknown> | null}
 */
export function describeWriterClaim(dbPath) {
  const infoPath = writerInfoPathFor(dbPath);
  if (!existsSync(infoPath)) return null;
  try {
    return JSON.parse(readFileSync(infoPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Claim the write lock, or fail closed.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} dbPath
 * @returns {{acquired: true} | {acquired: false, locked: boolean, cause: string, phase: string, claimed_by: Record<string, unknown> | null, mechanism: string}}
 */
export function claimWriteLock(db, dbPath) {
  try {
    db.exec('BEGIN IMMEDIATE');
    return { acquired: true };
  } catch (err) {
    return {
      acquired: false,
      locked: isLockRefusal(err),
      cause: describeCause(err),
      phase: 'claim-lock',
      claimed_by: describeWriterClaim(dbPath),
      mechanism: 'sqlite-write-lock',
    };
  }
}

/**
 * True when an error is SQLite refusing concurrent access, as opposed to any
 * other failure. Both spellings matter: `SQLITE_BUSY` surfaces as "database is
 * locked" through node:sqlite, and a WAL write from a second connection can
 * report "busy" instead.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isLockRefusal(err) {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return /database is locked|database table is locked|SQLITE_BUSY|SQLITE_LOCKED|\bbusy\b/i.test(message);
}

/**
 * @param {unknown} err
 * @returns {string}
 */
export function describeCause(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Release the write lock if this handle holds it.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {boolean} true when a transaction was rolled back
 */
export function releaseWriteLock(db) {
  try {
    db.exec('ROLLBACK');
    return true;
  } catch {
    return false;
  }
}

/**
 * Append a line to a sidecar file and flush it immediately. Used by subprocess
 * tests to record a crash marker that must survive a hard exit, which is exactly
 * what a buffered write would lose.
 *
 * @param {string} path
 * @param {string} text
 */
export function appendFlushed(path, text) {
  const fd = openSync(path, 'a');
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
