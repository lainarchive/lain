/**
 * Tests for src/core/ids.mjs — ULID generation and ordering.
 *
 * The property under test is the one the event store depends on: ids sort in
 * creation order, including when several are created inside one millisecond.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isUlid, resetUlidState, ulid, ulidTime } from '../../src/core/ids.mjs';

// Every test that asserts an exact timestamp starts from a clean latch; the
// latch is process-wide by design (see src/core/ids.mjs).
test('resetUlidState clears the monotonic latch', () => {
  const t = 1_650_000_123_456;
  ulid(Date.now());
  resetUlidState();
  assert.equal(ulidTime(ulid(t)), t);
});

test('ulid has 26 Crockford base32 characters and validates', () => {
  const id = ulid();
  assert.equal(id.length, 26);
  assert.ok(isUlid(id), `expected ${id} to validate`);
  assert.ok(!/[ILOU]/.test(id), 'must not use the ambiguous letters I, L, O, U');
});

test('ulid rejects non-ids', () => {
  for (const bad of ['', 'too-short', 'a'.repeat(26), '01ARZ3NDEKTSV4RRFFQ69G5FA', null, 42]) {
    assert.equal(isUlid(bad), false, `${JSON.stringify(bad)} must not validate`);
  }
});

test('ulid is lexicographically ordered by time', () => {
  const t0 = 1_700_000_000_000;
  const ids = [ulid(t0), ulid(t0 + 1), ulid(t0 + 1000), ulid(t0 + 1_000_000)];
  const sorted = [...ids].sort();
  assert.deepEqual(ids, sorted, 'generation order must equal sort order');
});

test('ids created inside one millisecond still sort in creation order', () => {
  const t = 1_700_000_500_000;
  const ids = Array.from({ length: 200 }, () => ulid(t));
  assert.deepEqual(ids, [...ids].sort(), 'monotonic increment failed within a single millisecond');
  assert.equal(new Set(ids).size, ids.length, 'ids must be unique');
});

test('ulidTime recovers the embedded timestamp', () => {
  const t = 1_650_000_123_456;
  resetUlidState();
  assert.equal(ulidTime(ulid(t)), t);
});

test('ulidTime refuses a malformed id instead of returning nonsense', () => {
  assert.throws(() => ulidTime('nope'), TypeError);
});

test('ids never go backwards when the clock does', () => {
  const t = 1_800_000_000_000;
  resetUlidState();
  const first = ulid(t);
  const second = ulid(t - 60_000); // clock moved backwards
  assert.ok(second > first, 'a backwards clock must not produce a smaller id');
  assert.ok(ulidTime(second) >= ulidTime(first), 'the embedded time must not regress either');
});
