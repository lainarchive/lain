/**
 * M-2 scaffold tests: the mock model integration, decided by the real policy
 * engine. Three tests, one per behaviour the scaffold exists to prove: the
 * happy path runs, a missing capability is refused by the engine (A6b, not a
 * crash), and a malformed task is refused before the policy is consulted.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ModelPolicyError, runTask, validateModelTask } from '../../src/model/integration.mjs';
import { StoreError } from '../../src/core/errors.mjs';

test('AT-M2-01 happy path: a granted task runs through the mock model', () => {
  const outcome = runTask(
    { id: 't-happy', prompt: 'hello', required_capabilities: ['model.invoke'] },
    { granted_capabilities: ['model.invoke'] },
  );
  assert.equal(outcome.taskId, 't-happy');
  assert.equal(outcome.result.answer, 'mock-response');
  assert.equal(outcome.result.echo, 'hello');
  assert.deepEqual(outcome.model, { provider: 'local', name: 'mock-model', cost: 0 });
  // The decision is recorded before the model is called; its id travels with
  // the result so the run can be traced back to the arm that allowed it.
  assert.match(outcome.decision_id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
});

test('AT-M2-02 missing capability: the policy refuses and the model is never called', () => {
  // The engine's contract is a total decision, not an exception: the refusal
  // arrives as A6b CAPABILITY_NOT_GRANTED, and the error carries the decision
  // so the caller (and the log) can see which arm refused.
  assert.throws(
    () =>
      runTask(
        { id: 't-denied', prompt: 'hello', required_capabilities: ['model.invoke'] },
        { granted_capabilities: [] },
      ),
    (err) =>
      err instanceof ModelPolicyError &&
      err.decision.arm_id === 'A6b' &&
      err.decision.reason_code === 'CAPABILITY_NOT_GRANTED' &&
      err.decision.outcome === 'defer',
  );
});

test('AT-M2-03 malformed task: refused before the policy is consulted', () => {
  // No required_capabilities at all, and a requirement set that is not an
  // array of strings. Both are shape failures with the store's stable code,
  // and neither may reach the policy engine or the model.
  assert.throws(() => runTask({ id: 't-bad', prompt: 'hello' }), (err) => err instanceof StoreError && err.code === 'INVALID_SHAPE');
  assert.throws(
    () => runTask({ id: 't-bad', prompt: 'hello', required_capabilities: 'model.invoke' }),
    (err) => err instanceof StoreError && err.code === 'INVALID_SHAPE',
  );
  assert.throws(
    () => validateModelTask({ id: 't-bad', prompt: 'hello', required_capabilities: ['model.invoke', ''] }),
    (err) => err instanceof StoreError && err.code === 'INVALID_SHAPE',
  );
});
