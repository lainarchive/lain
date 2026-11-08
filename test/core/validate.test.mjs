/**
 * Tests for src/core/validate.mjs — bounded validation helpers.
 *
 * These are the guards that stop a malformed value reaching storage. Each is
 * tested for the value it accepts AND the value it must refuse; a validator
 * tested only on good input is not tested.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Config,
  parseJsonObject,
  requireInteger,
  requireJsonValue,
  requireRecord,
  requireString,
  resolveLimit,
} from '../../src/core/validate.mjs';
import { ConfigError, StoreError } from '../../src/core/errors.mjs';

test('requireRecord accepts plain objects and refuses everything else', () => {
  assert.deepEqual(requireRecord({ a: 1 }, 'x'), { a: 1 });
  for (const bad of [null, [], 'text', 42, undefined]) {
    assert.throws(() => requireRecord(bad, 'x'), StoreError);
  }
});

test('requireString enforces type, emptiness, length and pattern', () => {
  assert.equal(requireString('ok', 'x'), 'ok');
  assert.equal(requireString('ABC-1', 'x', { pattern: /^[A-Z]+-\d$/ }), 'ABC-1');
  assert.throws(() => requireString('', 'x'), StoreError);
  assert.throws(() => requireString(5, 'x'), StoreError);
  assert.throws(() => requireString('abcd', 'x', { max: 3 }), StoreError);
  assert.throws(() => requireString('abc', 'x', { pattern: /^\d+$/ }), StoreError);
});

test('requireInteger enforces integrality and range', () => {
  assert.equal(requireInteger(0, 'x'), 0);
  assert.equal(requireInteger(5, 'x', { min: 1, max: 10 }), 5);
  assert.throws(() => requireInteger(1.5, 'x'), StoreError);
  assert.throws(() => requireInteger('5', 'x'), StoreError);
  assert.throws(() => requireInteger(11, 'x', { min: 1, max: 10 }), StoreError);
});

test('parseJsonObject returns issues rather than throwing', () => {
  const good = parseJsonObject('{"a":1}');
  assert.equal(good.ok, true);
  const bad = parseJsonObject('{not json');
  assert.equal(bad.ok, false);
  assert.ok(bad.ok === false && bad.issues.length > 0);
  const array = parseJsonObject('[1,2]');
  assert.equal(array.ok, false, 'a top-level array is not an object');
});

test('requireJsonValue refuses values that cannot be persisted faithfully', () => {
  assert.deepEqual(requireJsonValue({ a: [1, 'x', true, null] }, 'payload'), { a: [1, 'x', true, null] });
  assert.throws(() => requireJsonValue({ a: undefined }, 'payload'), StoreError);
  assert.throws(() => requireJsonValue({ a: Number.NaN }, 'payload'), StoreError);
  assert.throws(() => requireJsonValue({ a: 1n }, 'payload'), StoreError);
  assert.throws(() => requireJsonValue({ a: () => 1 }, 'payload'), StoreError);
});

test('requireJsonValue enforces the depth ceiling', () => {
  /** @type {any} */
  let deep = {};
  const root = deep;
  for (let i = 0; i < 40; i += 1) {
    deep.next = {};
    deep = deep.next;
  }
  assert.throws(() => requireJsonValue(root, 'payload', { maxDepth: 8 }), StoreError);
});

test('resolveLimit rejects a non-positive or inverted limit', () => {
  assert.equal(resolveLimit(undefined, 50, 1000), 50);
  assert.equal(resolveLimit(10, 50, 1000), 10);
  assert.throws(() => resolveLimit(0, 50, 1000), StoreError);
  assert.throws(() => resolveLimit(-1, 50, 1000), StoreError);
  assert.throws(() => resolveLimit(1001, 50, 1000), StoreError);
});

test('Config reads values explicitly and never invents a required one', () => {
  const cfg = new Config({ retries: 3 }, 'test fixture');
  assert.equal(cfg.get('missing', 'fallback'), 'fallback');
  assert.equal(cfg.requireInteger('retries', { min: 0, max: 5 }), 3);
  assert.throws(() => cfg.require('missing'), ConfigError);
  assert.throws(() => cfg.requireInteger('missing'), ConfigError);
});
