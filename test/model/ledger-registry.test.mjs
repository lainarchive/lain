// Ledger-backed approval feeds the model gate — resolution, augmentation, binding
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

import { ModelPolicyError, runTask } from '../../src/model/integration.mjs';
import { resolveLedgerApproval } from '../../src/model/registry.mjs';
import { recordApproval, resetApprovals } from '../../src/model/approvalLedger.mjs';
import { createPersistentLedger } from '../../src/model/persistentLedger.mjs';
import { StoreError } from '../../src/core/errors.mjs';

/**
 * The in-memory module ledger is process-wide, so every test starts from an
 * empty one — order independence is a property, not a hope.
 */
beforeEach(() => {
  resetApprovals();
});

const ROOT = mkdtempSync(join(tmpdir(), 'lain-m8-ledger-'));

after(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

/**
 * Seed the in-memory ledger the way an operator would have: a human with
 * model.admin recorded the decision. Returns the decision id for readability.
 *
 * @param {string} decisionId
 * @param {string} taskId
 * @param {'pending' | 'granted' | 'denied' | 'timed_out'} outcome
 */
function seed(decisionId, taskId, outcome) {
  recordApproval(
    { decision_id: decisionId, taskId, modelId: 'local-mock', outcome },
    { granted_capabilities: ['model.admin'] },
  );
  return decisionId;
}

/** A live-shaped task that holds the external capability. */
const CAPABLE_TASK = {
  id: 'task-m8-1',
  prompt: 'hello',
  required_capabilities: ['model.invoke.external'],
};

test('AT-M8-01: no ledger entry for the decision id is not a yes — A5 asks a human', () => {
  assert.throws(
    () => runTask(CAPABLE_TASK, { live: true, approvalId: '01M8UNKNOWNID', granted_capabilities: ['model.invoke.external'] }),
    (err) => err instanceof ModelPolicyError && err.decision.arm_id === 'A5' && err.decision.reason_code === 'EFFECT_CLASS_REQUIRES_APPROVAL',
  );
});

test('AT-M8-02: a granted entry bound to this task supplies the capability and the call proceeds', () => {
  seed('01M8GRANTED01', 'task-m8-1', 'granted');
  // The task declares the capability as REQUIRED but the caller grants
  // nothing: the augmentation is what makes the grant check pass.
  const result = runTask(CAPABLE_TASK, { live: true, approvalId: '01M8GRANTED01', granted_capabilities: [] });
  assert.equal(result.taskId, 'task-m8-1');
  assert.equal(result.result.answer, 'mock-response');
  assert.equal(result.decision.arm_id, 'A5b');
  assert.equal(result.decision.outcome, 'allow_with_conditions');
  assert.equal(result.decision.reason_code, 'APPROVED_EXTERNAL_INVOCATION');
  assert.equal(result.decision.approval_id, '01M8GRANTED01');
});

test('AT-M8-03: a denied entry is an explicit denial — A1', () => {
  seed('01M8DENIED01', 'task-m8-1', 'denied');
  assert.throws(
    () => runTask(CAPABLE_TASK, { live: true, approvalId: '01M8DENIED01', granted_capabilities: ['model.invoke.external'] }),
    (err) => err instanceof ModelPolicyError && err.decision.arm_id === 'A1' && err.decision.reason_code === 'EXPLICIT_DENIAL',
  );
});

test('AT-M8-04: a pending entry is not a yes — A5 asks again', () => {
  seed('01M8PENDING1', 'task-m8-1', 'pending');
  assert.throws(
    () => runTask(CAPABLE_TASK, { live: true, approvalId: '01M8PENDING1', granted_capabilities: ['model.invoke.external'] }),
    (err) => err instanceof ModelPolicyError && err.decision.arm_id === 'A5',
  );
});

test('AT-M8-05: a timed_out entry is A2 and non-retryable', () => {
  seed('01M8TIMEDOUT', 'task-m8-1', 'timed_out');
  assert.throws(
    () => runTask(CAPABLE_TASK, { live: true, approvalId: '01M8TIMEDOUT', granted_capabilities: ['model.invoke.external'] }),
    (err) => err instanceof ModelPolicyError && err.decision.arm_id === 'A2',
  );
});

test('AT-M8-06: the binding is the point — an approval for another task grants nothing here', () => {
  seed('01M8OTHERTAS', 'task-m8-OTHER', 'granted');
  // Same shape as AT-M8-02 except the entry names a different task: no
  // augmentation, the caller grants nothing, so A6b refuses before any
  // approval question is reached.
  assert.throws(
    () => runTask(CAPABLE_TASK, { live: true, approvalId: '01M8OTHERTAS', granted_capabilities: [] }),
    (err) => err instanceof ModelPolicyError && err.decision.arm_id === 'A6b' && err.decision.reason_code === 'CAPABILITY_NOT_GRANTED',
  );
});

test('AT-M8-07: the augmentation never duplicates the capability', () => {
  seed('01M8GRANTED02', 'task-m8-1', 'granted');
  const result = runTask(CAPABLE_TASK, {
    live: true,
    approvalId: '01M8GRANTED02',
    granted_capabilities: ['model.invoke.external'],
  });
  assert.equal(result.decision.arm_id, 'A5b');
});

test('AT-M8-08: the stub path is byte-identical to M-2 — no live, no approval, no ledger', () => {
  const result = runTask(
    { id: 'task-m8-stub', prompt: 'hello', required_capabilities: ['model.invoke'] },
    { granted_capabilities: ['model.invoke'] },
  );
  assert.equal(result.decision.arm_id, 'A7');
  assert.equal(result.result.answer, 'mock-response');
});

test('AT-M8-09: resolveLedgerApproval reports the raw entry and the bound verdict separately', () => {
  seed('01M8GRANTED03', 'task-m8-1', 'granted');
  const bound = resolveLedgerApproval('01M8GRANTED03', { taskId: 'task-m8-1' });
  assert.equal(bound.approved, true);
  assert.equal(bound.entry?.outcome, 'granted');
  const unbound = resolveLedgerApproval('01M8GRANTED03', { taskId: 'task-m8-OTHER' });
  assert.equal(unbound.approved, false);
  assert.equal(unbound.entry?.outcome, 'granted');
  const noTask = resolveLedgerApproval('01M8GRANTED03');
  assert.equal(noTask.approved, false, 'no task id, no augmentation — the M-7 invariant');
  assert.equal(noTask.entry?.outcome, 'granted');
  assert.deepEqual(resolveLedgerApproval('01M8ABSENTID'), { approved: false, entry: null });
  assert.deepEqual(resolveLedgerApproval(undefined), { approved: false, entry: null });
  const denied = resolveLedgerApproval(seed('01M8DENIED02', 'task-m8-1', 'denied'), { taskId: 'task-m8-1' });
  assert.equal(denied.approved, false);
  assert.equal(denied.entry?.outcome, 'denied', 'the outcome still feeds the engine unbound');
});

test('AT-M8-10: the persistent ledger answers through the same helper', () => {
  const dbPath = join(ROOT, 'm8-persistent.db');
  const ledger = createPersistentLedger(dbPath);
  try {
    ledger.add(
      { decision_id: '01M8PERSIST1', taskId: 'task-m8-1', modelId: 'local-mock', outcome: 'granted' },
      { granted_capabilities: ['model.admin'] },
    );
  } finally {
    ledger.close();
  }
  const reopened = createPersistentLedger(dbPath);
  try {
    const resolution = resolveLedgerApproval('01M8PERSIST1', { ledger: reopened, taskId: 'task-m8-1' });
    assert.equal(resolution.approved, true);
    const result = runTask(CAPABLE_TASK, { live: true, approvalId: '01M8PERSIST1', ledger: reopened, granted_capabilities: [] });
    assert.equal(result.decision.arm_id, 'A5b');
  } finally {
    reopened.close();
  }
});

test('AT-M8-11: a malformed task is still refused before any ledger is consulted', () => {
  assert.throws(
    () => runTask({ id: 'task-m8-bad', prompt: 'hello', required_capabilities: [] }, { live: true, approvalId: '01M8GRANTED01' }),
    (err) => err instanceof StoreError && err.code === 'INVALID_SHAPE',
  );
});
