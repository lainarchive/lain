/**
 * @generated
 * @purpose  M-4 tests: re-classification is authorized, logged, and never mutates the frozen registry
 * @requires Chief-of-Staff
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ReclassificationError,
  effectiveDescriptor,
  getReclassificationLog,
  reclassifyModel,
  resetReclassifications,
} from '../../src/model/reclassify.mjs';
import { ModelPolicyError } from '../../src/model/integration.mjs';
import { StoreError } from '../../src/core/errors.mjs';
import { MODEL_REGISTRY } from '../../src/model/registry.mjs';

test('AT-M4-04: an authorized reclassification changes the effective descriptor, not the registry', () => {
  resetReclassifications();
  const outcome = reclassifyModel('local-mock', 'read_only', { granted_capabilities: ['model.admin'] });
  assert.equal(outcome.modelId, 'local-mock');
  assert.equal(outcome.from, 'external', 'the mock ships external until its channel is proven local');
  assert.equal(outcome.to, 'read_only');
  assert.match(outcome.decision_id, /^[0-9A-HJKMNP-TV-Z]{26}$/, 'the authorizing decision id is a ULID');
  assert.equal(effectiveDescriptor('local-mock').effect_class, 'read_only');
  assert.equal(MODEL_REGISTRY['local-mock'].effect_class, 'external', 'the shipped registry stays frozen');
});

test('AT-M4-05: a second reclassification chains from the override and the log keeps both', () => {
  resetReclassifications();
  reclassifyModel('local-mock', 'read_only', { granted_capabilities: ['model.admin'] });
  const second = reclassifyModel('local-mock', 'external', { granted_capabilities: ['model.admin'] });
  assert.equal(second.from, 'read_only', 'the chain reads the effective value, not the frozen base');
  assert.equal(second.to, 'external');
  const log = getReclassificationLog();
  assert.equal(log.length, 2);
  assert.deepEqual(
    log.map((entry) => [entry.modelId, entry.from, entry.to]),
    [
      ['local-mock', 'external', 'read_only'],
      ['local-mock', 'read_only', 'external'],
    ],
  );
  for (const entry of log) assert.match(entry.decision_id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
});

test('AT-M4-06: re-classifying an unknown model is a caller error, not a policy refusal', () => {
  resetReclassifications();
  assert.throws(() => reclassifyModel('no-such-model', 'read_only', { granted_capabilities: ['model.admin'] }), (err) => {
    assert.ok(err instanceof ReclassificationError);
    assert.equal(err.code, 'RECLASSIFICATION_ERROR');
    return true;
  });
});

test('AT-M4-07: without model.admin the engine refuses and nothing changes', () => {
  resetReclassifications();
  assert.throws(() => reclassifyModel('local-mock', 'read_only', { granted_capabilities: [] }), (err) => {
    assert.ok(err instanceof ModelPolicyError);
    assert.equal(err.decision.arm_id, 'A6b');
    assert.equal(err.decision.reason_code, 'CAPABILITY_NOT_GRANTED');
    return true;
  });
  assert.equal(effectiveDescriptor('local-mock').effect_class, 'external', 'a refusal leaves no override behind');
  assert.equal(getReclassificationLog().length, 0);
});

test('AT-M4-08: an effect class outside the engine vocabulary is a shape error', () => {
  resetReclassifications();
  assert.throws(() => reclassifyModel('local-mock', 'omnipotent', { granted_capabilities: ['model.admin'] }), (err) => {
    assert.ok(err instanceof StoreError);
    assert.equal(err.code, 'INVALID_SHAPE');
    return true;
  });
  assert.equal(effectiveDescriptor('local-mock').effect_class, 'external');
});
