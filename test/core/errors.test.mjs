/**
 * Tests for src/core/errors.mjs — the error contract callers branch on.
 *
 * The property that matters: a failure carries a stable code and a
 * safe-to-record detail, so the event log can record *why* something failed
 * without recording anything it must not.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AdmissionError,
  ConfigError,
  IntegrityError,
  LainError,
  RedactionError,
  StoreError,
  StoreLockedError,
  describeError,
} from '../../src/core/errors.mjs';

test('every Lain error carries a code and a detail object', () => {
  const err = new LainError('SOMETHING', 'went wrong', { attempted: 2 });
  assert.equal(err.code, 'SOMETHING');
  assert.equal(err.message, 'went wrong');
  assert.deepEqual(err.detail, { attempted: 2 });
  assert.deepEqual(err.toRecord(), { code: 'SOMETHING', message: 'went wrong', detail: { attempted: 2 } });
});

test('detail defaults to an empty object rather than undefined', () => {
  assert.deepEqual(new StoreError('X', 'y').detail, {});
});

test('the hierarchy is as documented', () => {
  assert.ok(new ConfigError('A', 'b') instanceof LainError);
  assert.ok(new StoreError('A', 'b') instanceof LainError);
  assert.ok(new StoreLockedError('A', 'b') instanceof StoreError, 'a locked store is a store failure');
  assert.ok(new IntegrityError('A', 'b') instanceof StoreError, 'an integrity failure is a store failure');
  assert.ok(new RedactionError('A', 'b') instanceof LainError);
  assert.ok(new AdmissionError('deny', 'A', 'b') instanceof LainError);
});

test('the error name is the concrete class, so logs are readable', () => {
  assert.equal(new StoreLockedError('A', 'b').name, 'StoreLockedError');
  assert.equal(new LainError('A', 'b').name, 'LainError');
});

test('an admission refusal distinguishes denial from indeterminacy', () => {
  const denied = new AdmissionError('deny', 'OVER_BUDGET', 'exceeds the configured limit');
  const unknown = new AdmissionError('indeterminate', 'MEASUREMENT_UNKNOWN', 'free memory could not be read');
  assert.equal(denied.outcome, 'deny');
  assert.equal(unknown.outcome, 'indeterminate');
  assert.notEqual(denied.outcome, unknown.outcome, 'indeterminate must never collapse into deny');
});

test('describeError narrows unknown throws without inventing structure', () => {
  const lain = describeError(new StoreError('CODE', 'message', { a: 1 }));
  assert.deepEqual(lain, { code: 'CODE', message: 'message', detail: { a: 1 } });

  const generic = describeError(new TypeError('bad type'));
  assert.equal(generic.code, 'UNEXPECTED_ERROR');
  assert.equal(generic.message, 'bad type');
  assert.deepEqual(generic.detail, { name: 'TypeError' });

  const thrown = describeError('just a string');
  assert.equal(thrown.code, 'UNEXPECTED_THROW');
  assert.equal(thrown.message, 'just a string');
});
