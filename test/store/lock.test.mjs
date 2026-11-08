import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { open } from '../../src/store/index.mjs';
import { lockPathFor, writerInfoPathFor } from '../../src/store/lock.mjs';

/**
 * AT-M1-08..AT-M1-12: single-writer ownership.
 *
 * Every assertion here is produced by a real second process. Nothing infers an
 * ownership guarantee from this process's own state, because the defect being
 * guarded against (two writers, one log) is invisible from inside one process.
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const childScript = join(here, '..', 'helpers', 'store-child.mjs');

/** @param {string} name */
function scratch(name) {
  return mkdtempSync(join(tmpdir(), `lain-store-${name}-`));
}

/** @param {string} dir */
function cleanup(dir) {
  if (process.env.LAIN_KEEP_TEMP !== '1') rmSync(dir, { recursive: true, force: true });
}

/** @param {number} ms */
async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** @param {string} path @param {number} [timeoutMs] */
async function waitForFile(path, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await sleep(20);
  }
  return false;
}

/**
 * Run a child to completion and parse its result file.
 * @param {string} dir @param {Record<string, unknown>} request
 */
function runChild(dir, request) {
  const id = Math.random().toString(36).slice(2, 8);
  const requestPath = join(dir, `request-${id}.json`);
  const resultPath = join(dir, `request-${id}.result.json`);
  writeFileSync(requestPath, `${JSON.stringify({ result: resultPath, ...request }, null, 2)}\n`, 'utf8');
  const proc = spawnSync(process.execPath, [childScript, requestPath], { encoding: 'utf8', windowsHide: true });
  const result = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : null;
  return { proc, result };
}

/**
 * Start a child that stays alive until its `go` file appears.
 * @param {string} dir @param {Record<string, unknown>} request
 */
function startChild(dir, request) {
  const id = Math.random().toString(36).slice(2, 8);
  const requestPath = join(dir, `bg-${id}.json`);
  const resultPath = join(dir, `bg-${id}.result.json`);
  writeFileSync(requestPath, `${JSON.stringify({ result: resultPath, ...request }, null, 2)}\n`, 'utf8');
  const proc = spawn(process.execPath, [childScript, requestPath], { stdio: 'ignore', windowsHide: true });
  const exited = new Promise((resolve) => proc.on('exit', resolve));
  return { proc, exited, resultPath };
}

test('AT-M1-08: a second process is refused while the first holds the writer lock', async () => {
  const dir = scratch('lock-refused');
  const db = join(dir, 'events.db');
  const ready = join(dir, 'ready');
  const go = join(dir, 'go');

  const first = startChild(dir, { db, op: 'hold', readyFile: ready, goFile: go, count: 1 });
  assert.ok(await waitForFile(ready), 'the first process never reported readiness');

  const second = runChild(dir, { db, op: 'contend', lockTimeoutMs: 0 });
  assert.equal(second.result?.ok, false, `the second process was not refused: ${JSON.stringify(second.result)}`);
  assert.equal(second.result?.code, 'STORE_LOCKED');
  assert.equal(second.proc.status, 1);

  writeFileSync(go, 'go\n');
  await first.exited;

  const store = open({ path: db });
  assert.equal(store.stats().count, 1, 'the refused process must not have written anything');
  store.close();
  cleanup(dir);
});

test('AT-M1-09: ownership comes back after a normal exit', async () => {
  const dir = scratch('lock-release');
  const db = join(dir, 'events.db');
  const ready = join(dir, 'ready');
  const go = join(dir, 'go');

  const first = startChild(dir, { db, op: 'hold', readyFile: ready, goFile: go, count: 1 });
  assert.ok(await waitForFile(ready));
  writeFileSync(go, 'go\n');
  await first.exited;

  assert.ok(!existsSync(writerInfoPathFor(db)), 'the writer metadata file should be gone after a clean exit');
  const store = open({ path: db });
  assert.equal(store.stats().count, 1);
  store.close();
  cleanup(dir);
});

test('AT-M1-10: a process that exits without closing leaves a lock file the successor ignores', () => {
  const dir = scratch('lock-crash');
  const db = join(dir, 'events.db');
  const crashLog = join(dir, 'crash.log');

  const child = runChild(dir, { db, op: 'crash-hold', count: 2, crashLog });
  assert.equal(child.proc.status, 0, `child failed: ${JSON.stringify(child.result)}`);
  assert.ok(existsSync(crashLog), 'the child never recorded its crash marker');

  // The lock file itself is expected to remain: a hard exit cannot remove it.
  assert.ok(existsSync(lockPathFor(db)), 'the lock file should still exist after a hard exit');
  const staleClaim = JSON.parse(readFileSync(writerInfoPathFor(db), 'utf8'));
  assert.equal(typeof staleClaim.pid, 'number');

  const store = open({ path: db, writerId: 'successor' });
  assert.equal(store.stats().count, 2, 'the successor must see the events the crashed writer committed');
  store.close();
  const reopened = open({ path: db });
  assert.equal(reopened.stats().count, 2);
  reopened.close();
  cleanup(dir);
});

test('AT-M1-11: forged metadata cannot grant ownership to a second live writer', async () => {
  const dir = scratch('stale-metadata');
  const db = join(dir, 'events.db');
  const ready = join(dir, 'ready');
  const go = join(dir, 'go');

  const first = startChild(dir, { db, op: 'hold', readyFile: ready, goFile: go, count: 1 });
  assert.ok(await waitForFile(ready));

  // Forge metadata claiming the lock belongs to this (live) test process. If
  // ownership were decided by reading this file, the forged claim would win.
  writeFileSync(
    writerInfoPathFor(db),
    `${JSON.stringify({ writer_id: 'forged', pid: process.pid, host: 'forged', started_at: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  );

  const second = runChild(dir, { db, op: 'contend', lockTimeoutMs: 0 });
  assert.equal(second.result?.ok, false, `forged metadata was accepted as ownership: ${JSON.stringify(second.result)}`);
  assert.equal(second.result?.code, 'STORE_LOCKED');

  writeFileSync(go, 'go\n');
  await first.exited;
  cleanup(dir);
});

test('AT-M1-12: with the lock file removed, SQLite still refuses a second writer', async () => {
  const dir = scratch('sqlite-layer');
  const db = join(dir, 'events.db');
  const ready = join(dir, 'ready');
  const go = join(dir, 'go');

  const first = startChild(dir, { db, op: 'hold', readyFile: ready, goFile: go, count: 1 });
  assert.ok(await waitForFile(ready));

  // Remove the whole Lain lock layer, leaving only SQLite's own protection.
  unlinkSync(lockPathFor(db));
  try {
    unlinkSync(writerInfoPathFor(db));
  } catch {
    /* already gone */
  }

  const second = runChild(dir, { db, op: 'append', count: 1, skipLock: true, skipSqliteWriteProbe: true });
  assert.equal(second.proc.status, 1, `the second writer was not refused: ${JSON.stringify(second.result)}`);
  assert.match(String(second.result?.message ?? ''), /locked|busy/i);

  writeFileSync(go, 'go\n');
  await first.exited;
  cleanup(dir);
});

test('AT-M1-12b (positive control): after the first writer exits, appends succeed and sequence stays contiguous', () => {
  const dir = scratch('sqlite-layer-control');
  const db = join(dir, 'events.db');
  const first = runChild(dir, { db, op: 'append', count: 3 });
  assert.equal(first.proc.status, 0, `first append failed: ${JSON.stringify(first.result)}`);
  const second = runChild(dir, { db, op: 'append', count: 2 });
  assert.equal(second.proc.status, 0, `second append failed: ${JSON.stringify(second.result)}`);
  const store = open({ path: db });
  assert.equal(store.stats().count, 5);
  assert.deepEqual(store.read({ limit: 10 }).map((event) => event.seq), [1, 2, 3, 4, 5]);
  store.close();
  cleanup(dir);
});

test('AT-M1-10b (positive control): a stale lock file does not block a fresh writer', () => {
  const dir = scratch('stale-lock-control');
  const db = join(dir, 'events.db');
  writeFileSync(lockPathFor(db), '', 'utf8');
  writeFileSync(writerInfoPathFor(db), `${JSON.stringify({ writer_id: 'ghost', pid: 999_999 })}\n`, 'utf8');
  const store = open({ path: db });
  store.record('store.opened', { by: 'stale-lock-control' });
  assert.equal(store.stats().count, 1);
  store.close();
  cleanup(dir);
});
