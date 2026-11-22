// The approval ledger is gated, shape-checked, and never rewrites history
import test from 'node:test';
import assert from 'node:assert/strict';
import { listApprovals, recordApproval, resetApprovals } from '../../src/model/approvalLedger.mjs';
import { ModelPolicyError } from '../../src/model/integration.mjs';
import { StoreError } from '../../src/core/errors.mjs';
import { DEFAULT_RULES } from '../../src/policy/rules.mjs';

const ENTRY = { decision_id: '01M7E8TESTDECISION0000000A', taskId: 't-1', modelId: 'local-mock', outcome: 'granted' };

test('AT-M5-05: an empty ledger lists as an empty array', () => {
  resetApprovals();
  assert.deepEqual(listApprovals(), []);
});

test('AT-M5-06: an authorized record lands in the ledger with the ledger timestamp', () => {
  resetApprovals();
  const stored = recordApproval(ENTRY, { granted_capabilities: ['model.admin'] });
  assert.equal(stored.decision_id, ENTRY.decision_id);
  assert.equal(stored.outcome, 'granted');
  assert.match(stored.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, 'the recording time is an ISO instant');
  assert.equal(listApprovals().length, 1);
});

test('AT-M5-07: without model.admin the engine refuses and nothing is recorded', () => {
  resetApprovals();
  assert.throws(() => recordApproval(ENTRY, { granted_capabilities: [] }), (err) => {
    assert.ok(err instanceof ModelPolicyError);
    assert.equal(err.decision.arm_id, 'A6b');
    assert.equal(err.decision.reason_code, 'CAPABILITY_NOT_GRANTED');
    return true;
  });
  assert.deepEqual(listApprovals(), []);
});

test('AT-M5-08: a missing rule row is a refusal, not a silent write', () => {
  resetApprovals();
  const rulesWithoutRow = { ...DEFAULT_RULES, tools: { ...DEFAULT_RULES.tools } };
  delete rulesWithoutRow.tools['model.approval.record'];
  assert.throws(() => recordApproval(ENTRY, { rules: rulesWithoutRow, granted_capabilities: ['model.admin'] }), (err) => {
    assert.ok(err instanceof ModelPolicyError);
    assert.equal(err.decision.arm_id, 'A3');
    return true;
  });
  assert.deepEqual(listApprovals(), []);
});

test('AT-M5-09: shape errors are thrown before the engine is asked', () => {
  resetApprovals();
  assert.throws(() => recordApproval({ ...ENTRY, decision_id: '' }, { granted_capabilities: ['model.admin'] }), (err) => {
    assert.ok(err instanceof StoreError);
    assert.equal(err.code, 'INVALID_SHAPE');
    return true;
  });
  assert.throws(() => recordApproval({ taskId: 't', modelId: 'm', outcome: 'granted' }, { granted_capabilities: ['model.admin'] }), (err) => {
    assert.ok(err instanceof StoreError);
    return true;
  });
  assert.deepEqual(listApprovals(), []);
});

test('AT-M5-10: an outcome outside the engine vocabulary is a shape error', () => {
  resetApprovals();
  assert.throws(() => recordApproval({ ...ENTRY, outcome: 'maybe' }, { granted_capabilities: ['model.admin'] }), (err) => {
    assert.ok(err instanceof StoreError);
    assert.equal(err.code, 'INVALID_SHAPE');
    return true;
  });
});

test('AT-M5-11: a duplicate decision id is refused and the original entry survives', () => {
  resetApprovals();
  recordApproval(ENTRY, { granted_capabilities: ['model.admin'] });
  assert.throws(() => recordApproval({ ...ENTRY, outcome: 'denied' }, { granted_capabilities: ['model.admin'] }), (err) => {
    assert.ok(err instanceof StoreError);
    assert.equal(err.code, 'INVALID_SHAPE');
    return true;
  });
  const listed = listApprovals();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].outcome, 'granted', 'the original record was not overwritten');
});

test('AT-M5-12: list returns a copy — mutating it does not touch the ledger', () => {
  resetApprovals();
  recordApproval(ENTRY, { granted_capabilities: ['model.admin'] });
  const copy = listApprovals();
  copy.length = 0;
  assert.equal(listApprovals().length, 1);
});

test('AT-M5-13: list entries are copies — mutating one does not touch the ledger', () => {
  resetApprovals();
  recordApproval(ENTRY, { granted_capabilities: ['model.admin'] });
  const listed = listApprovals();
  listed[0].outcome = 'denied';
  assert.equal(listApprovals()[0].outcome, 'granted');
});

test('AT-M5-14: the ledger preserves insertion order and optional fields', () => {
  resetApprovals();
  recordApproval(ENTRY, { granted_capabilities: ['model.admin'] });
  recordApproval({ ...ENTRY, decision_id: '01M7E8TESTDECISION0000000B', outcome: 'denied', decided_by: 'Jaden' }, { granted_capabilities: ['model.admin'] });
  const listed = listApprovals();
  assert.deepEqual(
    listed.map((entry) => entry.decision_id),
    [ENTRY.decision_id, '01M7E8TESTDECISION0000000B'],
    'the order decisions were recorded is part of the record',
  );
  assert.equal(listed[1].decided_by, 'Jaden');
});

test('AT-M5-15: the ledger timestamps the recording, not the caller claim', () => {
  resetApprovals();
  const stored = recordApproval({ ...ENTRY, at: '1999-01-01T00:00:00.000Z' }, { granted_capabilities: ['model.admin'] });
  assert.notEqual(stored.at, '1999-01-01T00:00:00.000Z', 'a caller-supplied timestamp is not trusted');
});

test('AT-M5-16: resetApprovals clears everything (test seam, not a production path)', () => {
  resetApprovals();
  recordApproval(ENTRY, { granted_capabilities: ['model.admin'] });
  resetApprovals();
  assert.deepEqual(listApprovals(), []);
});
