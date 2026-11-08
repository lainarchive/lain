import { readFileSync, writeFileSync } from 'node:fs';
import { open } from '../../src/store/index.mjs';
import { appendFlushed } from '../../src/store/lock.mjs';
import { ulid } from '../../src/core/ids.mjs';

/**
 * Subprocess driver for store tests.
 *
 * Usage: node test/helpers/store-child.mjs <command.json>
 * The command file is `{ db, op, ... }` and the result is written next to it as
 * `<command>.result.json` (or wherever `result` points), so a test never has to
 * parse this process's stdout.
 *
 * Commands:
 *   hold          open the store, record readiness, then wait for the `go` file
 *   append        open, append n events, close
 *   crash-append  open, append n events, then exit without closing
 *   crash-hold    open, append, record readiness, then exit without closing
 *   contend       try to open (expect a refusal) and report the outcome
 *
 * Test-only switches forwarded to the store: `skipLock`, `skipSqliteWriteProbe`.
 * They exist so a test can remove one protection and observe the other still hold.
 */

const requestPath = process.argv[2];
if (requestPath === undefined) {
  process.stderr.write('usage: store-child.mjs <command.json>\n');
  process.exit(2);
}
const request = JSON.parse(readFileSync(requestPath, 'utf8'));
const resultPath = request.result ?? `${requestPath}.result.json`;

/** @param {unknown} value */
function report(value) {
  writeFileSync(resultPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** @param {number} ms */
function sleep(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    /* deliberate spin: this process must not keep an event loop alive */
  }
}

/** @param {string} path */
function fileExists(path) {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} path @param {number} timeoutMs */
function waitForFile(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fileExists(path)) return true;
    sleep(10);
  }
  return false;
}

let store = null;
try {
  store = open({
    path: request.db,
    producer: request.producer ?? 'test.child',
    ...(request.writerId === undefined ? {} : { writerId: request.writerId }),
    ...(request.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: request.lockTimeoutMs }),
    ...(request.skipLock === true ? { skipLock: true } : {}),
    ...(request.skipSqliteWriteProbe === true ? { skipSqliteWriteProbe: true } : {}),
  });

  if (request.op === 'contend') {
    report({ ok: false, unexpected: 'open() succeeded while another writer was expected to hold the lock' });
    store.close();
    process.exit(3);
  }

  const count = request.count ?? 1;
  if (count > 0) {
    const drafts = Array.from({ length: count }, (_, index) => ({
      event_id: ulid(Date.now() + index),
      event_type: request.eventType ?? 'task.state.changed',
      occurred_at: new Date().toISOString(),
      producer: request.producer ?? 'test.child',
      payload: { child: process.pid, index, ...(request.payload ?? {}) },
    }));
    store.append(drafts);
  }

  if (request.op === 'crash-append' || request.op === 'crash-hold') {
    // A hard exit: no close(), no lock release, no checkpoint. This is the
    // "unexpected termination" case the ownership tests must survive.
    appendFlushed(request.crashLog, `${process.pid}\n`);
    process.exit(0);
  }

  if (request.op === 'hold') {
    appendFlushed(request.readyFile, `${process.pid}\n`);
    const released = waitForFile(request.goFile, 60_000);
    if (!released) {
      report({ ok: false, message: 'the go file never appeared' });
      store.close();
      process.exit(4);
    }
    store.close();
    report({ ok: true, released: true, pid: process.pid });
    process.exit(0);
  }

  const stats = store.stats();
  store.close();
  report({ ok: true, pid: process.pid, stats });
  process.exit(0);
} catch (err) {
  report({
    ok: false,
    code: /** @type {any} */ (err)?.code ?? 'NO_CODE',
    name: /** @type {any} */ (err)?.name ?? 'Error',
    message: err instanceof Error ? err.message : String(err),
    detail: /** @type {any} */ (err)?.detail ?? null,
  });
  try {
    if (store) store.close();
  } catch {
    /* the process is ending anyway */
  }
  process.exit(1);
}
