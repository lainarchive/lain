/**
 * @generated
 * @purpose  M-6 tests: the persistent ledger is gated, shape-checked, never rewrites history, and survives reopen
 * @requires Chief-of-Staff
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPersistentLedger } from '../../src/model/persistentLedger.mjs';
import { ModelPolicyError } from '../../src/model/integration.mjs';
import { StoreError } from '../../src/core/errors.mjs';
import { DEFAULT_RULES } from '../../src/policy/rules.mjs';

const ENTRY = { decision_id: '01M7E8TESTDECISION0000000B', taskId: 't-1', modelId: 'local-mock', outcome: 'granted' };
const ROOT = mkdtempSync(join(tmpdir(), 'lain-m6-ledger-'));

test.after(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

test('AT-M6-01: a fresh ledger lists as an empty array', () => {
  const ledger = createPersistentLedger(':memory:');
  try {
    assert.deepEqual(ledger.list(), []);
  } finally {
    ledger.close();
  }
});

test('AT-M6-02: an authorized add lands in the ledger with the ledger timestamp', () => {
  const ledger = createPersistentLedger(':memory:');
  try {
    const stored = ledger.add(ENTRY, { granted_capabilities: ['model.admin'] });
    assert.equal(stored.decision_id, ENTRY.decision_id);
    assert.equal(stored.outcome, 'granted');
    assert.match(stored.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, 'the recording time is an ISO instant');
    assert.equal(ledger.list().length, 1);
  } finally {
    ledger.close();
  }
});

test('AT-M6-03: without model.admin the engine refuses and nothing is persisted', () => {
  const ledger = createPersistentLedger(':memory:');
  try {
    assert.throws(() => ledger.add(ENTRY, { granted_capabilities: [] }), (err) => {
      assert.ok(err instanceof ModelPolicyError);
      assert.equal(err.decision.arm_id, 'A6b');
      assert.equal(err.decision.reason_code, 'CAPABILITY_NOT_GRANTED');
      return true;
    });
    assert.deepEqual(ledger.list(), []);
  } finally {
    ledger.close();
  }
});

test('AT-M6-04: a missing rule row is a refusal, not a silent write', () => {
  const ledger = createPersistentLedger(':memory:');
  try {
    const rulesWithoutRow = { ...DEFAULT_RULES, tools: { ...DEFAULT_RULES.tools } };
    delete rulesWithoutRow.tools['model.approval.persist'];
    assert.throws(() => ledger.add(ENTRY, { rules: rulesWithoutRow, granted_capabilities: ['model.admin'] }), (err) => {
      assert.ok(err instanceof ModelPolicyError);
      assert.equal(err.decision.arm_id, 'A3');
      return true;
    });
    assert.deepEqual(ledger.list(), []);
  } finally {
    ledger.close();
  }
});

test('AT-M6-05: shape errors are thrown before the engine is asked', () => {
  const ledger = createPersistentLedger(':memory:');
  try {
    assert.throws(() => ledger.add({ ...ENTRY, decision_id: '' }, { granted_capabilities: ['model.admin'] }), (err) => {
      assert.ok(err instanceof StoreError);
      assert.equal(err.code, 'INVALID_SHAPE');
      return true;
    });
    assert.throws(() => ledger.add({ taskId: 't', modelId: 'm', outcome: 'granted' }, { granted_capabilities: ['model.admin'] }), (err) => {
      assert.ok(err instanceof StoreError);
      return true;
    });
    assert.deepEqual(ledger.list(), []);
  } finally {
    ledger.close();
  }
});

test('AT-M6-06: an outcome outside the engine vocabulary is a shape error', () => {
  const ledger = createPersistentLedger(':memory:');
  try {
    assert.throws(() => ledger.add({ ...ENTRY, outcome: 'maybe' }, { granted_capabilities: ['model.admin'] }), (err) => {
      assert.ok(err instanceof StoreError);
      assert.equal(err.code, 'INVALID_SHAPE');
      return true;
    });
  } finally {
    ledger.close();
  }
});

test('AT-M6-07: a duplicate decision id is refused and the original row survives', () => {
  const ledger = createPersistentLedger(':memory:');
  try {
    ledger.add(ENTRY, { granted_capabilities: ['model.admin'] });
    assert.throws(() => ledger.add({ ...ENTRY, outcome: 'denied' }, { granted_capabilities: ['model.admin'] }), (err) => {
      assert.ok(err instanceof StoreError);
      assert.equal(err.code, 'INVALID_SHAPE');
      assert.match(err.message, /duplicate approval record/);
      return true;
    });
    const rows = ledger.list();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, 'granted', 'the refused rewrite must not touch the original');
  } finally {
    ledger.close();
  }
});

test('AT-M6-08: decided_by is preserved when present and omitted when absent', () => {
  const ledger = createPersistentLedger(':memory:');
  try {
    const withBy = ledger.add({ ...ENTRY, decided_by: 'Jaden' }, { granted_capabilities: ['model.admin'] });
    assert.equal(withBy.decided_by, 'Jaden');
    const withoutBy = ledger.add({ ...ENTRY, decision_id: ENTRY.decision_id + 'C' }, { granted_capabilities: ['model.admin'] });
    assert.equal('decided_by' in withoutBy, false);
  } finally {
    ledger.close();
  }
});

test('AT-M6-09: the caller-supplied timestamp is not trusted — the ledger clocks the write', async () => {
  const ledger = createPersistentLedger(':memory:');
  try {
    const before = new Date().toISOString();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const stored = ledger.add({ ...ENTRY, at: '1999-01-01T00:00:00.000Z' }, { granted_capabilities: ['model.admin'] });
    assert.ok(stored.at > before, 'the stored instant must come from the ledger clock, not the caller');
  } finally {
    ledger.close();
  }
});

test('AT-M6-10: rows come back in insertion order, as copies', () => {
  const ledger = createPersistentLedger(':memory:');
  try {
    ledger.add(ENTRY, { granted_capabilities: ['model.admin'] });
    ledger.add({ ...ENTRY, decision_id: ENTRY.decision_id + 'D', taskId: 't-2' }, { granted_capabilities: ['model.admin'] });
    const rows = ledger.list();
    assert.deepEqual(rows.map((row) => row.taskId), ['t-1', 't-2']);
    rows[0].outcome = 'mutated';
    assert.equal(ledger.list()[0].outcome, 'granted', 'callers read history, they do not edit it');
  } finally {
    ledger.close();
  }
});

test('AT-M6-11: a file-backed ledger survives close and reopen', () => {
  const dbPath = join(ROOT, 'reopen.db');
  const first = createPersistentLedger(dbPath);
  first.add(ENTRY, { granted_capabilities: ['model.admin'] });
  first.close();
  const second = createPersistentLedger(dbPath);
  try {
    const rows = second.list();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].decision_id, ENTRY.decision_id);
    assert.equal(rows[0].outcome, 'granted');
  } finally {
    second.close();
  }
});

test('AT-M6-12: a duplicate add against a reopened file-backed ledger is still refused', () => {
  const dbPath = join(ROOT, 'reopen-dup.db');
  const first = createPersistentLedger(dbPath);
  first.add(ENTRY, { granted_capabilities: ['model.admin'] });
  first.close();
  const second = createPersistentLedger(dbPath);
  try {
    assert.throws(() => second.add({ ...ENTRY, outcome: 'denied' }, { granted_capabilities: ['model.admin'] }), (err) => {
      assert.ok(err instanceof StoreError);
      assert.match(err.message, /duplicate approval record/);
      return true;
    });
    assert.equal(second.list().length, 1);
  } finally {
    second.close();
  }
});
