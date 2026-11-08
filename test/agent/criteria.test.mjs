import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCriteria } from '../../src/agent/task-runner.mjs';

/**
 * V-1 criteria evaluation tests (AT-V1-AGENT-*).
 *
 * The single property this file exists for: an unevaluable criterion is never
 * counted as passed. A task that "completes" because its check could not be
 * evaluated is the exact failure the milestone is designed to prevent.
 */

/** @param {any} partial */
function criterion(partial) {
  return { id: 'c1', statement: 'a statement', required: true, check: { kind: 'artifact', path: 'health.json' }, ...partial };
}

test('AT-V1-AGENT-01: an artifact that is present passes; one that is absent fails', () => {
  const ctx = { toolResult: { artifacts: [{ path: 'health.json', bytes: 12 }], exit_code: 0 } };
  const present = evaluateCriteria([criterion({})], ctx);
  assert.equal(present[0]?.verdict, 'passed');

  const absent = evaluateCriteria([criterion({ check: { kind: 'artifact', path: 'other.json' } })], ctx);
  assert.equal(absent[0]?.verdict, 'failed');
});

test('AT-V1-AGENT-02: an artifact criterion with no path is not_evaluated, never passed', () => {
  const checks = evaluateCriteria([criterion({ check: { kind: 'artifact' } })], { toolResult: { artifacts: [] } });
  assert.equal(checks[0]?.verdict, 'not_evaluated');
  assert.notEqual(checks[0]?.verdict, 'passed');
});

test('AT-V1-AGENT-03: a command criterion is never executed and never reported as passed', () => {
  const ctx = { toolResult: { artifacts: [], exit_code: 0 } };
  const checks = evaluateCriteria([criterion({ check: { kind: 'command', spec: 'npm test' } })], ctx);
  assert.equal(checks[0]?.verdict, 'not_evaluated');
  assert.match(String(checks[0]?.detail), /not executed/i);
});

test('AT-V1-AGENT-04: an unknown criterion kind is not_evaluated, so adding a kind cannot silently widen success', () => {
  const checks = evaluateCriteria([criterion({ check: { kind: 'magic' } })], { toolResult: { artifacts: [] } });
  assert.equal(checks[0]?.verdict, 'not_evaluated');
  assert.match(String(checks[0]?.detail), /unknown criterion kind/i);
});

test('AT-V1-AGENT-05: an exit-code assertion compares the observed code, and says what it saw', () => {
  const spec = criterion({ check: { kind: 'assertion', exit_code: 0 } });
  const passed = evaluateCriteria([spec], { toolResult: { artifacts: [], exit_code: 0 } });
  assert.equal(passed[0]?.verdict, 'passed');

  const failed = evaluateCriteria([spec], { toolResult: { artifacts: [], exit_code: 3 } });
  assert.equal(failed[0]?.verdict, 'failed');
  assert.match(String(failed[0]?.detail), /3 observed/);

  const unknown = evaluateCriteria([criterion({ check: { kind: 'assertion' } })], { toolResult: { artifacts: [] } });
  assert.equal(unknown[0]?.verdict, 'not_evaluated');
});

test('AT-V1-AGENT-06: a criterion that failed stays failed even when every other one passed', () => {
  const checks = evaluateCriteria(
    [
      criterion({ id: 'a', check: { kind: 'artifact', path: 'health.json' } }),
      criterion({ id: 'b', check: { kind: 'artifact', path: 'missing.json' } }),
    ],
    { toolResult: { artifacts: [{ path: 'health.json', bytes: 1 }], exit_code: 0 } },
  );
  const failures = checks.filter((c) => c.verdict === 'failed');
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.id, 'b');
});
