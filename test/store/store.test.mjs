import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { open } from '../../src/store/index.mjs';
import { StoreError, LainError } from '../../src/core/errors.mjs';
import { ulid } from '../../src/core/ids.mjs';

/**
 * AT-M1-01..AT-M1-07, AT-M1-18: the write path.
 *
 * Each refusal is paired with a positive control, because a store that refuses
 * everything would pass every "must refuse" test in this file.
 */

/** @param {string} name */
function scratch(name) {
  const dir = mkdtempSync(join(tmpdir(), `lain-store-${name}-`));
  return { dir, db: join(dir, 'events.db') };
}

/** @param {string} dir */
function cleanup(dir) {
  if (process.env.LAIN_KEEP_TEMP !== '1') rmSync(dir, { recursive: true, force: true });
}

/** @param {Record<string, unknown>} [extra] */
function draft(extra = {}) {
  return {
    event_id: ulid(),
    event_type: 'task.state.changed',
    occurred_at: new Date().toISOString(),
    producer: 'test',
    payload: { state: 'running' },
    ...extra,
  };
}

test('AT-M1-01: a valid batch is written, sequenced from 1, and readable', () => {
  const { dir, db } = scratch('valid');
  const store = open({ path: db });
  const receipt = store.append([draft(), draft(), draft()]);
  assert.equal(receipt.count, 3);
  assert.equal(receipt.from_seq, 1);
  assert.equal(receipt.to_seq, 3);
  assert.equal(store.stats().count, 3);
  const events = store.read({ limit: 10 });
  assert.deepEqual(events.map((event) => event.seq), [1, 2, 3]);
  assert.equal(events[0].payload.state, 'running');
  store.close();
  cleanup(dir);
});

test('AT-M1-01b (positive control): sequence continues across writer generations', () => {
  const { dir, db } = scratch('sequence');
  const first = open({ path: db });
  first.append([draft()]);
  first.close();
  const second = open({ path: db });
  const receipt = second.append([draft()]);
  assert.equal(receipt.from_seq, 2);
  second.close();
  const third = open({ path: db });
  assert.deepEqual(third.read({ limit: 10 }).map((event) => event.seq), [1, 2]);
  third.close();
  cleanup(dir);
});

test('AT-M1-02: an invalid draft is refused and nothing is written', () => {
  const { dir, db } = scratch('invalid');
  const store = open({ path: db });
  const cases = [
    [{ ...draft(), event_id: 'not-a-ulid' }, /ULID/],
    [{ ...draft(), event_type: 'NotDotted' }, /dotted/],
    [{ ...draft(), occurred_at: 'yesterday' }, /at least 20 characters/],
    [{ ...draft(), occurred_at: 'not-a-timestamp-but-long-enough' }, /ISO-8601/],
    [{ ...draft(), schema_version: 99 }, /schema_version 99/],
    [{ ...draft(), producer: '' }, /producer/],
  ];
  for (const [bad, pattern] of cases) {
    assert.throws(() => store.append([bad]), (err) => err instanceof StoreError && pattern.test(err.message), `expected a refusal for ${JSON.stringify(bad).slice(0, 80)}`);
  }
  const missing = draft();
  delete missing.payload;
  assert.throws(() => store.append([missing]), StoreError);
  assert.equal(store.stats().count, 0, 'a refused batch must not write anything');
  store.close();
  cleanup(dir);
});

test('AT-M1-02b (positive control): the same drafts with valid fields are accepted', () => {
  const { dir, db } = scratch('invalid-control');
  const store = open({ path: db });
  const receipt = store.append([draft(), draft({ session_id: 'sess_1', task_id: 'task_1', causation_id: 'evt_parent' })]);
  assert.equal(receipt.count, 2);
  assert.equal(store.read({ limit: 1 })[0].session_id, 'session_unassigned', 'a draft without a session is stored, not refused');
  store.close();
  cleanup(dir);
});

test('AT-M1-03: a duplicate event id is refused by the store, not by luck', () => {
  const { dir, db } = scratch('duplicate');
  const store = open({ path: db });
  const one = draft();
  store.append([one]);
  assert.throws(() => store.append([draft({ event_id: one.event_id })]), (err) => /UNIQUE|constraint/i.test(String(err.message)));
  assert.equal(store.stats().count, 1);
  store.close();
  cleanup(dir);
});

test('AT-M1-03b (positive control): a different id is accepted', () => {
  const { dir, db } = scratch('duplicate-control');
  const store = open({ path: db });
  store.append([draft()]);
  store.append([draft()]);
  assert.equal(store.stats().count, 2);
  store.close();
  cleanup(dir);
});

test('AT-M1-04: a batch containing one invalid event writes none of its events', () => {
  const { dir, db } = scratch('atomic');
  const store = open({ path: db });
  const good = [draft(), draft()];
  const bad = { ...draft(), event_type: 'invalid type' };
  assert.throws(() => store.append([...good, bad]), StoreError);
  assert.equal(store.stats().count, 0, 'the valid events in a failed batch must not be written');
  const receipt = store.append(good);
  assert.equal(receipt.count, 2);
  assert.equal(store.stats().count, 2);
  store.close();
  cleanup(dir);
});

test('AT-M1-05: an empty batch and an oversized batch are refused', () => {
  const { dir, db } = scratch('batch-bounds');
  const store = open({ path: db });
  assert.throws(() => store.append([]), (err) => /EMPTY_BATCH/.test(String(err.code)));
  assert.throws(() => store.append('not an array'), (err) => /INVALID_BATCH/.test(String(err.code)));
  assert.throws(() => store.append(Array.from({ length: 1001 }, () => draft())), (err) => /BATCH_TOO_LARGE/.test(String(err.code)));
  assert.equal(store.stats().count, 0);
  store.close();
  cleanup(dir);
});

test('AT-M1-05b (positive control): a batch of 1000 is accepted', () => {
  const { dir, db } = scratch('batch-limit');
  const store = open({ path: db });
  const receipt = store.append(Array.from({ length: 1000 }, () => draft()));
  assert.equal(receipt.count, 1000);
  assert.equal(store.stats().max_seq, 1000);
  store.close();
  cleanup(dir);
});

test('AT-M1-06: reads are bounded, ordered and filterable', () => {
  const { dir, db } = scratch('read');
  const store = open({ path: db });
  store.append([
    draft({ event_type: 'task.admitted', session_id: 'sess_a' }),
    draft({ event_type: 'policy.decided', session_id: 'sess_a' }),
    draft({ event_type: 'task.admitted', session_id: 'sess_b', task_id: 'task_x' }),
  ]);
  assert.equal(store.read({ limit: 2 }).length, 2, 'limit must bound the result');
  assert.deepEqual(store.read({ event_type: 'task.admitted' }).map((event) => event.seq), [1, 3]);
  assert.deepEqual(store.read({ session_id: 'sess_a' }).map((event) => event.seq), [1, 2]);
  assert.deepEqual(store.read({ task_id: 'task_x' }).map((event) => event.seq), [3]);
  assert.deepEqual(store.read({ from_seq: 2, to_seq: 3 }).map((event) => event.seq), [2, 3]);
  assert.throws(() => store.read({ limit: 5000 }), (err) => /limit/.test(String(err.message)));
  store.close();
  cleanup(dir);
});

test('AT-M1-06b (positive control): a stored event can be fetched by id', () => {
  const { dir, db } = scratch('read-by-id');
  const store = open({ path: db });
  const one = draft();
  store.append([one]);
  const found = store.get(one.event_id);
  assert.equal(found?.event_id, one.event_id);
  assert.equal(store.get(ulid()), null);
  store.close();
  cleanup(dir);
});

test('AT-M1-07: a payload that cannot be serialized faithfully is refused', () => {
  const { dir, db } = scratch('payload-shape');
  const store = open({ path: db });
  for (const bad of [Number.NaN, 10n, () => 1]) {
    assert.throws(
      () => store.append([draft({ payload: { bad } })]),
      (err) => err instanceof LainError && /PAYLOAD_NOT_SERIALIZABLE/.test(String(err.code)),
      `payload value ${String(bad)} should have been refused`,
    );
  }
  // `undefined` is refused by the serializer with its own named path, which is
  // more useful to a caller than a generic refusal.
  assert.throws(() => store.append([draft({ payload: { bad: undefined } })]), (err) => err instanceof LainError);
  assert.equal(store.stats().count, 0);
  store.close();
  cleanup(dir);
});

test('AT-M1-07b (positive control): a payload with nested objects and arrays is stored intact', () => {
  const { dir, db } = scratch('payload-shape-control');
  const store = open({ path: db });
  const payload = { nested: { list: [1, 2, { deep: 'value' }], flag: true, null: null } };
  store.append([draft({ payload })]);
  assert.deepEqual(store.read({ limit: 1 })[0].payload, payload);
  store.close();
  cleanup(dir);
});

test('AT-M1-18: the store refuses to append after it is closed', () => {
  const { dir, db } = scratch('closed');
  const store = open({ path: db });
  store.close();
  assert.throws(() => store.append([draft()]), (err) => /STORE_CLOSED/.test(String(err.code)));
  assert.throws(() => store.read({}), (err) => /STORE_CLOSED/.test(String(err.code)));
  assert.doesNotThrow(() => store.close(), 'closing twice must be harmless');
  cleanup(dir);
});

test('AT-M1-18b (positive control): reopening the same path works and keeps the schema version', () => {
  const { dir, db } = scratch('reopen');
  const first = open({ path: db });
  first.close();
  const second = open({ path: db });
  assert.equal(second.schema_version, 1);
  assert.equal(second.stats().schema_version, 1);
  second.close();
  cleanup(dir);
});

test('AT-M1-16: a store whose schema version is from the future is refused, not migrated silently', () => {
  const { dir, db } = scratch('schema-mismatch');
  const store = open({ path: db });
  store.close();
  // Rewrite the recorded version directly; this is what a newer build would leave.
  const raw = new DatabaseSync(db);
  raw.prepare('UPDATE meta SET value = ? WHERE key = ?').run('999', 'store_schema_version');
  raw.close();
  assert.throws(() => open({ path: db }), (err) => /SCHEMA_MISMATCH/.test(String(err.code)));
  cleanup(dir);
});
