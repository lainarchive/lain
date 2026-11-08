import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTaskStore } from '../../src/tasks/store.mjs';
import { validateTaskDraft, normaliseBudget, TaskContractError } from '../../src/tasks/contract.mjs';
import { checkTransition, isTerminal, transitionRequirements } from '../../src/tasks/states.mjs';

/**
 * V-1 task tests (AT-V1-TASK-*).
 *
 * The properties that matter: a task without acceptance criteria is never
 * admitted, capabilities are granted once and never widened, an illegal
 * transition is refused *and recorded as refused*, and a task cannot reach
 * `completed` on claims without evidence.
 */

const NOW = () => 1_700_000_000_000;

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'lain-taskstore-'));
  const store = openTaskStore({ path: join(dir, 'tasks.db'), now: NOW });
  try {
    return fn(store, dir);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function draft(overrides = {}) {
  return {
    objective: 'prove the toolchain works',
    acceptance_criteria: [
      {
        id: 'c1',
        statement: 'the health check wrote health.json into the workspace',
        check: { kind: 'artifact', path: 'health.json' },
        required: true,
      },
    ],
    capabilities: ['workspace.write', 'process.spawn'],
    effect_class: 'local_reversible',
    budget: { max_tool_calls: 2, max_wall_ms: 30_000 },
    ...overrides,
  };
}

function contract(overrides = {}) {
  return validateTaskDraft(draft(overrides), { now: NOW });
}

test('AT-V1-TASK-01: a task with no acceptance criteria is refused, so nothing is ever admitted unverifiably', () => {
  assert.throws(() => validateTaskDraft(draft({ acceptance_criteria: [] }), { now: NOW }), (err) => {
    assert.ok(err instanceof TaskContractError);
    assert.match(String(err.message), /NO_ACCEPTANCE_CRITERIA|criterion/i);
    return true;
  });
});

test('AT-V1-TASK-01b (positive control): a well-formed draft is accepted and its required criteria survive', () => {
  const c = contract();
  assert.equal(c.acceptance_criteria.length, 1);
  assert.equal(c.acceptance_criteria[0]?.required, true);
  assert.equal(c.effect_class, 'local_reversible');
  assert.equal(c.effect_class_known, true);
});

test('AT-V1-TASK-02: a budget cannot be opted out of by omitting it', () => {
  const budget = normaliseBudget({});
  assert.equal(typeof budget.max_tool_calls, 'number');
  assert.equal(typeof budget.max_wall_ms, 'number');
  assert.equal(typeof budget.max_output_bytes, 'number');
  assert.equal(budget.max_model_calls, 0, 'v0.1 makes no model calls, and the budget says so');
  // A declared value above the ceiling is clamped, not honoured.
  assert.ok(normaliseBudget({ max_tool_calls: 100_000 }).max_tool_calls <= 100);
  // A nonsense value falls back to the conservative default rather than zero.
  assert.ok(normaliseBudget({ max_wall_ms: -5 }).max_wall_ms > 0);
});

test('AT-V1-TASK-03: capabilities are granted once; a second grant is refused rather than merged', () => {
  withStore((store) => {
    const created = store.create({ contract: contract(), origin: 'test' });
    store.grantCapabilities(created.task_id, ['workspace.write', 'process.spawn'], { granted_by: 'test' });
    assert.deepEqual(store.capabilities(created.task_id).sort(), ['process.spawn', 'workspace.write']);
    assert.throws(
      () => store.grantCapabilities(created.task_id, ['workspace.read'], { granted_by: 'test' }),
      /CAPABILITIES_ALREADY_GRANTED|already/i,
      'merging on a second grant is how a running task widens its own authority',
    );
    assert.deepEqual(
      store.capabilities(created.task_id).sort(),
      ['process.spawn', 'workspace.write'],
      'the refused grant must not have added anything',
    );
  });
});

/** Assert that a thrown error carries a specific machine-readable code. */
function hasCode(code) {
  return (/** @type {any} */ err) => {
    assert.equal(err?.code, code, `expected error code ${code}, got ${err?.code}: ${err?.message}`);
    return true;
  };
}

test('AT-V1-TASK-04: an illegal transition is refused and recorded as refused', () => {
  withStore((store) => {
    const created = store.create({ contract: contract(), origin: 'test' });
    store.transition(created.task_id, 'admitted', { reason: 'test' });
    assert.throws(() => store.transition(created.task_id, 'completed', { reason: 'too early' }), hasCode('ILLEGAL_TRANSITION'));
    const history = store.history(created.task_id);
    const refusedRow = history.find((row) => String(row.reason ?? '').startsWith('refused:'));
    assert.ok(refusedRow, `a refused transition must leave a row, got ${JSON.stringify(history)}`);
    assert.equal(refusedRow.reason, 'refused:ILLEGAL_TRANSITION');
    assert.equal(refusedRow.to, 'completed', 'the refused target is recorded so the attempt is legible afterwards');
    assert.equal(store.get(created.task_id)?.state, 'admitted', 'a refused transition must not change the state');
  });
});

test('AT-V1-TASK-05: completed requires its evidence — an unmet requirement is refused, not assumed', () => {
  withStore((store) => {
    const created = store.create({ contract: contract(), origin: 'test' });
    store.transition(created.task_id, 'admitted', { reason: 'test' });
    store.transition(created.task_id, 'running', { reason: 'test' });
    assert.throws(
      () => store.transition(created.task_id, 'completed', { reason: 'claims only' }),
      hasCode('TRANSITION_REQUIREMENTS_UNMET'),
    );
    assert.equal(store.get(created.task_id)?.state, 'running');
  });
});

test('AT-V1-TASK-06: a result with an empty evidence list cannot reach completed (positive control: a full result can)', () => {
  withStore((store) => {
    const created = store.create({ contract: contract(), origin: 'test' });
    store.transition(created.task_id, 'admitted', { reason: 'test' });
    store.transition(created.task_id, 'running', { reason: 'test' });

    // Shape is enforced first: every field must be an array.
    assert.throws(
      () => store.setResult(created.task_id, /** @type {any} */ ({ claims: ['done'] })),
      hasCode('RESULT_SHAPE_INVALID'),
    );

    const emptyEvidence = {
      claims: ['the check passed'],
      artifacts: [],
      evidence: [],
      checks: [{ id: 'c1', statement: 'health.json exists', required: true, status: 'passed' }],
      not_verified: [],
      indeterminate: [],
    };
    const stored = store.setResult(created.task_id, emptyEvidence);
    assert.deepEqual(stored?.evidence, [], 'the result is stored — refusing to store it would lose the attempt');

    // The store records the result; the *guard* is that completed demands
    // evidence, so a caller that tries to complete on claims alone is refused.
    assert.throws(
      () => store.transition(created.task_id, 'completed', { reason: 'claims only', evidence: { requiredChecksPassed: true } }),
      hasCode('TRANSITION_REQUIREMENTS_UNMET'),
    );

    const good = store.setResult(created.task_id, { ...emptyEvidence, evidence: ['health.json written by run_script'] });
    assert.deepEqual(good?.evidence, ['health.json written by run_script']);
    const done = store.transition(created.task_id, 'completed', { reason: 'verified', evidence: { requiredChecksPassed: true } });
    assert.equal(done.to, 'completed');
    const verdict = store.verify(created.task_id);
    assert.equal(verdict.ok, true, `a legitimately completed task must verify clean, got ${JSON.stringify(verdict.findings)}`);
    assert.deepEqual(verdict.findings, []);
  });
});

test('AT-V1-TASK-07: the state machine has no route out of a terminal state', () => {
  for (const state of ['completed', 'failed', 'cancelled', 'cancel_failed']) {
    assert.equal(isTerminal(state), true, `${state} must be terminal`);
    for (const to of ['submitted', 'admitted', 'running', 'completed']) {
      assert.equal(checkTransition(state, to).legal, false, `${state} → ${to} must be illegal`);
      assert.equal(checkTransition(state, to).code, 'TERMINAL_IS_TERMINAL');
    }
  }
  assert.deepEqual(transitionRequirements('completed', {}), ['required_checks_passed', 'recorded_evidence']);
  assert.deepEqual(transitionRequirements('completed', { requiredChecksPassed: true, evidenceCount: 2 }), []);
  assert.deepEqual(transitionRequirements('cancelled', {}), ['zero_surviving_processes']);
});

test('AT-V1-TASK-08: verify reports what it cannot prove rather than staying silent', () => {
  withStore((store) => {
    const created = store.create({ contract: contract(), origin: 'test' });
    // Force the mismatch the verify step exists to catch: a state whose history
    // does not agree with it.
    store.transition(created.task_id, 'admitted', { reason: 'test' });
    const verdict = store.verify(created.task_id);
    assert.equal(verdict.ok, true, `a consistent task must verify clean, got ${JSON.stringify(verdict.findings)}`);
    assert.deepEqual(verdict.findings, []);

    // And the check can fire: verifying a task that does not exist reports it
    // rather than returning silence.
    const missing = store.verify('01HF7YAT00AAAAAAAAAAAAAAAA');
    assert.equal(missing.ok, false);
    assert.equal(missing.findings[0]?.code, 'TASK_NOT_FOUND');
  });
});
