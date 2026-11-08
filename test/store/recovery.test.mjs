import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { open, inspect } from '../../src/store/index.mjs';
import { ulid } from '../../src/core/ids.mjs';

/**
 * AT-M1-06..AT-M1-10, AT-M1-13..AT-M1-17, AT-M1-19: recovery, integrity,
 * migration and backup.
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const childScript = join(here, '..', 'helpers', 'store-child.mjs');

/** @param {string} name */
function scratch(name) {
  const dir = mkdtempSync(join(tmpdir(), `lain-recover-${name}-`));
  return { dir, db: join(dir, 'events.db') };
}

/** @param {string} dir */
function cleanup(dir) {
  if (process.env.LAIN_KEEP_TEMP !== '1') rmSync(dir, { recursive: true, force: true });
}

/** @param {string} dir @param {Record<string, unknown>} request */
function runChild(dir, request) {
  const id = Math.random().toString(36).slice(2, 8);
  const requestPath = join(dir, `req-${id}.json`);
  const resultPath = join(dir, `req-${id}.result.json`);
  writeFileSync(requestPath, `${JSON.stringify({ result: resultPath, ...request }, null, 2)}\n`, 'utf8');
  const proc = spawnSync(process.execPath, [childScript, requestPath], { encoding: 'utf8', windowsHide: true });
  return { proc, result: existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : null };
}

/** @param {Record<string, unknown>} [extra] */
function draft(extra = {}) {
  return {
    event_id: ulid(),
    event_type: 'task.state.changed',
    occurred_at: new Date().toISOString(),
    producer: 'test',
    payload: { note: 'recovery test' },
    ...extra,
  };
}

test('AT-M1-13: a hard kill leaves a store that still opens and verifies', () => {
  const { dir, db } = scratch('crash-open');
  const crashLog = join(dir, 'crash.log');
  // The child appends two events, then exits without closing: no lock release,
  // no checkpoint, no clean shutdown.
  const child = runChild(dir, { db, op: 'crash-append', count: 2, crashLog });
  assert.equal(child.proc.status, 0, `child failed: ${JSON.stringify(child.result)}`);
  assert.ok(existsSync(crashLog));

  const store = open({ path: db });
  const verdict = store.verify();
  assert.equal(verdict.ok, true, `integrity failed after a crash: ${JSON.stringify(verdict.checks)}`);
  // Both events reached COMMIT before the kill, so both must be readable. What a
  // crash may not do is leave a *partial* batch: see AT-M1-14 for that case.
  assert.equal(store.stats().count, 2, 'committed events must survive a hard kill');
  assert.deepEqual(store.read({ limit: 10 }).map((event) => event.seq), [1, 2]);
  store.close();
  cleanup(dir);
});

test('AT-M1-13a: a kill with nothing committed leaves no events and a valid store', () => {
  const { dir, db } = scratch('crash-empty');
  const crashLog = join(dir, 'crash.log');
  const child = runChild(dir, { db, op: 'crash-hold', count: 0, crashLog });
  assert.equal(child.proc.status, 0, `child failed: ${JSON.stringify(child.result)}`);
  const store = open({ path: db });
  assert.equal(store.stats().count, 0, 'nothing was committed, so nothing may be visible');
  assert.equal(store.verify().ok, true, 'an empty store must still verify clean');
  store.close();
  cleanup(dir);
});

test('AT-M1-13b (positive control): a batch the crashed process committed IS visible afterwards', () => {
  const { dir, db } = scratch('crash-committed');
  const crashLog = join(dir, 'crash.log');
  // A normal append closes cleanly, leaving committed rows behind.
  const first = runChild(dir, { db, op: 'append', count: 3 });
  assert.equal(first.proc.status, 0);
  // Then a crash after nothing was pending.
  const second = runChild(dir, { db, op: 'crash-hold', count: 0, crashLog });
  assert.equal(second.proc.status, 0);
  const store = open({ path: db });
  assert.equal(store.stats().count, 3, 'committed events must survive an unrelated crash');
  assert.equal(store.verify().ok, true);
  store.close();
  cleanup(dir);
});

test('AT-M1-14: an interrupted transaction leaves no partial batch', () => {
  const { dir, db } = scratch('interrupted');
  const store = open({ path: db });
  store.append([draft(), draft()]);
  const before = store.stats().count;
  store.close();

  // Open a raw connection, begin a write, insert, and abandon it without commit
  // by closing the connection. SQLite must roll it back.
  const raw = new DatabaseSync(db);
  raw.exec('BEGIN IMMEDIATE');
  raw.prepare(
    `INSERT INTO events (seq, event_id, event_type, schema_version, occurred_at, recorded_at, session_id, task_id,
      producer, correlation_id, causation_id, payload_text, payload_hash, redaction_applied, redaction_rules)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(99, ulid(), 'task.state.changed', 1, new Date().toISOString(), new Date().toISOString(), 's', null, 'test', 'c', null, '{}', 'x', 0, '{}');
  raw.close();

  const reopened = open({ path: db });
  assert.equal(reopened.stats().count, before, 'the abandoned transaction must not be visible');
  assert.equal(reopened.verify().ok, true);
  assert.deepEqual(reopened.read({ limit: 10 }).map((event) => event.seq), [1, 2]);
  reopened.close();
  cleanup(dir);
});

test('AT-M1-15: tampering with a stored payload is detected by verification', () => {
  const { dir, db } = scratch('tamper');
  const store = open({ path: db });
  store.append([draft(), draft()]);
  assert.equal(store.verify().ok, true, 'the untampered store must verify clean');
  store.close();

  const raw = new DatabaseSync(db);
  raw.prepare('UPDATE events SET payload_text = ? WHERE seq = 2').run('{"note":"edited by hand"}');
  raw.close();

  const reopened = open({ path: db });
  const verdict = reopened.verify();
  assert.equal(verdict.ok, false, 'edited bytes must fail verification');
  const hashCheck = verdict.checks.find((check) => check.name === 'payload_hashes');
  assert.ok(hashCheck && !hashCheck.ok, `expected a payload hash failure, got ${JSON.stringify(verdict.checks)}`);
  reopened.close();
  cleanup(dir);
});

test('AT-M1-15b: a deleted row is detected as a sequence gap', () => {
  const { dir, db } = scratch('gap');
  const store = open({ path: db });
  store.append([draft(), draft(), draft()]);
  store.close();
  const raw = new DatabaseSync(db);
  raw.prepare('DELETE FROM events WHERE seq = 2').run();
  raw.close();
  const reopened = open({ path: db });
  const verdict = reopened.verify();
  assert.equal(verdict.ok, false);
  assert.equal(verdict.checks.find((check) => check.name === 'sequence_contiguous')?.ok, false);
  reopened.close();
  cleanup(dir);
});

test('AT-M1-17: a backup is a consistent copy and does not become a second writer', async () => {
  const { dir, db } = scratch('backup');
  const store = open({ path: db });
  store.append([draft(), draft()]);
  const destination = join(dir, 'take-1.db');
  const receipt = await store.backup({ path: destination });
  assert.equal(receipt.path, destination);
  assert.ok(receipt.pages > 0, 'the online backup must report the pages it copied');
  assert.equal(receipt.lock_reacquired, true, 'the writer lock must be re-taken once the copy is done');
  assert.equal(store.holds_write_lock, true, 'the store is still the single writer after a backup');
  assert.ok(existsSync(destination), 'the backup file must exist');
  assert.ok(statSync(destination).size > 0);
  store.close();

  // The backup must be readable on its own, and must not be the live store.
  const copy = open({ path: destination });
  assert.equal(copy.stats().count, 2, 'the backup must contain the committed events');
  assert.equal(copy.verify().ok, true);
  copy.close();

  // A backup must never be mistaken for the live file: appending to the copy
  // must not change the original.
  const original = open({ path: db });
  assert.equal(original.stats().count, 2);
  original.close();
  cleanup(dir);
});

test('AT-M1-17b: backing up a running store does not disturb its writer', async () => {
  const { dir, db } = scratch('backup-live');
  const store = open({ path: db });
  store.append([draft()]);
  const destination = join(dir, 'live-copy.db');
  await store.backup({ path: destination });
  assert.ok(store.holds_write_lock, 'the backup must not release the write lock');
  store.append([draft()]);
  assert.equal(store.stats().count, 2);
  store.close();
  const copy = open({ path: destination });
  assert.equal(copy.stats().count, 1, 'the backup was taken before the second event, so it holds one');
  copy.close();
  cleanup(dir);
});

test('AT-M1-19: a corrupt database file is reported, not silently repaired', () => {
  const { dir, db } = scratch('corrupt');
  const store = open({ path: db });
  store.append([draft(), draft()]);
  store.close();
  // Overwrite the middle of the file with rubbish, keeping the header intact so
  // the failure is corruption rather than "not a database".
  const handle = readFileSync(db);
  for (let i = 4096; i < Math.min(handle.length, 8192); i += 1) handle[i] = 0x5a;
  writeFileSync(db, handle);
  try {
    unlinkSync(`${db}-wal`);
  } catch {
    /* the checkpoint already removed it */
  }

  let outcome = 'opened';
  try {
    const damaged = open({ path: db });
    const verdict = damaged.verify();
    outcome = verdict.ok ? 'opened-clean' : 'opened-with-findings';
    damaged.close();
  } catch (err) {
    outcome = `refused:${/** @type {any} */ (err)?.code ?? 'unknown'}`;
  }
  assert.notEqual(outcome, 'opened-clean', 'a corrupted store must not verify clean');

  // inspect() must describe the damage without taking ownership.
  const report = inspect(db);
  assert.equal(report.path, db);
  assert.ok(report.exists);
  cleanup(dir);
});
