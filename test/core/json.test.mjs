/**
 * Tests for src/core/json.mjs — canonical serialization and hashing.
 *
 * These test the property integrity metadata depends on: the same logical value
 * always produces the same bytes, and a value that cannot be represented
 * faithfully is refused rather than silently changed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalJson, canonicalHash, hashBytes } from '../../src/core/json.mjs';
import { IntegrityError } from '../../src/core/errors.mjs';

test('canonicalJson sorts object keys', () => {
  assert.equal(canonicalJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
});

test('canonicalJson sorts keys at every depth', () => {
  const left = { outer: { z: [3, { b: 1, a: 0 }], a: null } };
  const right = { outer: { a: null, z: [3, { a: 0, b: 1 }] } };
  assert.equal(canonicalJson(left), canonicalJson(right));
});

test('canonicalJson preserves array order', () => {
  assert.equal(canonicalJson([3, 1, 2]), '[3,1,2]');
});

test('canonicalJson emits no insignificant whitespace', () => {
  assert.equal(canonicalJson({ a: [1, 2], b: 'x' }), '{"a":[1,2],"b":"x"}');
});

test('canonicalHash is a stable 64-character hex digest', () => {
  const h = canonicalHash({ kind: 'task.admitted', seq: 1 });
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(h, canonicalHash({ seq: 1, kind: 'task.admitted' }));
});

test('canonicalHash matches an independently computed sha256 of the canonical text', () => {
  const value = { b: [1, { d: 4, c: 3 }], a: 'text' };
  const expected = createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
  assert.equal(canonicalHash(value), expected);
});

test('canonicalJson refuses values it would have to change', () => {
  assert.throws(() => canonicalJson({ a: undefined }), IntegrityError);
  assert.throws(() => canonicalJson({ a: Number.NaN }), IntegrityError);
  assert.throws(() => canonicalJson({ a: Number.POSITIVE_INFINITY }), IntegrityError);
  assert.throws(() => canonicalJson({ a: 1n }), IntegrityError);
  assert.throws(() => canonicalJson({ a: () => 1 }), IntegrityError);
});

test('a refusal names the offending path', () => {
  try {
    canonicalJson({ outer: { inner: [1, undefined] } });
    assert.fail('expected a refusal');
  } catch (err) {
    assert.ok(err instanceof IntegrityError);
    assert.match(String(/** @type {any} */ (err).detail.path), /outer\.inner\[1\]/);
  }
});

test('hashBytes hashes raw bytes, not canonical text', () => {
  const data = Buffer.from('abc', 'utf8');
  assert.equal(hashBytes(data), createHash('sha256').update(data).digest('hex'));
  assert.notEqual(hashBytes(data), canonicalHash('abc'));
});
