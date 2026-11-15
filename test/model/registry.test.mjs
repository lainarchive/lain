/**
 * M-3 scaffold tests: the model registry and the human-approval gate. The
 * gate is exercised against the real policy engine — the external entry must
 * land in A5 and throw, and the non-external path must return without
 * inventing an approval. The registry is injected for that path rather than
 * adding a falsely-classed entry to the real one.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HumanApprovalNeeded, requireHumanApproval } from '../../src/model/approval.mjs';
import { MODEL_REGISTRY, getModel } from '../../src/model/registry.mjs';
import { StoreError } from '../../src/core/errors.mjs';

test('AT-M3-01 registry lookup returns the full descriptor for local-mock', () => {
  const model = getModel('local-mock');
  assert.deepEqual(model, MODEL_REGISTRY['local-mock']);
  assert.equal(model.id, 'local-mock');
  assert.equal(model.provider, 'local');
  assert.equal(model.name, 'mock-model');
  assert.equal(model.cost, 0);
  // The class is the gate's input: the mock stays external until its channel
  // is proven local, so the approval path is exercisable, not decorative.
  assert.equal(model.effect_class, 'external');
});

test('AT-M3-02 unknown model id resolves to undefined, not an error', () => {
  assert.equal(getModel('does-not-exist'), undefined);
});

test('AT-M3-03 the gate hands an external model to a human: A5, decision attached', () => {
  assert.throws(
    () =>
      requireHumanApproval(
        { id: 't-external' },
        'local-mock',
        { granted_capabilities: ['model.invoke'] },
      ),
    (err) =>
      err instanceof HumanApprovalNeeded &&
      err.code === 'HUMAN_APPROVAL_REQUIRED' &&
      err.taskId === 't-external' &&
      err.modelId === 'local-mock' &&
      err.decision.arm_id === 'A5' &&
      err.decision.outcome === 'require_approval' &&
      /^[0-9A-HJKMNP-TV-Z]{26}$/.test(err.decision_id),
  );
});

test('AT-M3-04 the gate returns without a human for a local, permitted model', () => {
  // Injected registry: a proven-local model with the same capability row.
  // This is the path a real local model takes after M-4 proves its channel.
  const local = { 'local-mock': { ...MODEL_REGISTRY['local-mock'], effect_class: 'read_only' } };
  const outcome = requireHumanApproval(
    { id: 't-local' },
    'local-mock',
    { registry: local, granted_capabilities: ['model.invoke'] },
  );
  assert.equal(outcome.required, false);
  assert.equal(outcome.taskId, 't-local');
  assert.equal(outcome.modelId, 'local-mock');
  assert.match(outcome.decision_id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  // An unknown id is a caller error, not an approval need.
  assert.throws(
    () => requireHumanApproval({ id: 't-x' }, 'nope', { granted_capabilities: ['model.invoke'] }),
    (err) => err instanceof StoreError && err.code === 'INVALID_SHAPE',
  );
});
