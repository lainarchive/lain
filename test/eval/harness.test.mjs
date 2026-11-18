import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EVAL_STATUSES, EvalError, openExperimentRegistry } from '../../src/eval/harness.mjs';

function makeTempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'lain-eval-test-'));
  return {
    dir,
    dbPath: join(dir, 'eval.db'),
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function makeClock(startMs = Date.parse('2026-11-18T00:00:00.000Z')) {
  let current = startMs;
  return () => {
    current += 1000;
    return current;
  };
}

test('AT-P7-01: registerExperiment stores provenance, validates inputs, and rejects duplicate ids', () => {
  const tmp = makeTempDb();
  const registry = openExperimentRegistry({ path: tmp.dbPath, now: makeClock() });
  try {
    assert.deepEqual(EVAL_STATUSES, ['active', 'rolled_back']);
    assert.equal(Object.isFrozen(EVAL_STATUSES), true);

    const exp = registry.registerExperiment({
      id: 'exp-01',
      name: 'qwen-vs-llama-coding',
      candidateModel: 'qwen2.5-coder:7b',
      baselineModel: 'llama3.1:8b',
      source: 'local-ollama',
      hardware: { gpu: 'RTX 4090', vram_gb: 24 },
    });

    assert.equal(exp.id, 'exp-01');
    assert.equal(exp.name, 'qwen-vs-llama-coding');
    assert.equal(exp.candidate_model, 'qwen2.5-coder:7b');
    assert.equal(exp.baseline_model, 'llama3.1:8b');
    assert.equal(exp.status, 'active');
    assert.equal(exp.source, 'local-ollama');
    assert.deepEqual(exp.hardware, { gpu: 'RTX 4090', vram_gb: 24 });
    assert.equal(exp.rolled_back_by, null);
    assert.equal(exp.rolled_back_at, null);
    assert.equal(exp.rollback_reason, null);
    assert.equal(exp.created_at, '2026-11-18T00:00:01.000Z');

    assert.deepEqual(registry.get('exp-01'), exp);
    assert.equal(registry.get('missing'), null);
    assert.equal(registry.list().length, 1);
    assert.equal(registry.list({ status: 'active' }).length, 1);
    assert.equal(registry.list({ status: 'rolled_back' }).length, 0);

    assert.throws(
      () =>
        registry.registerExperiment({
          id: 'exp-01',
          name: 'dup',
          candidateModel: 'a',
          baselineModel: 'b',
          source: 'cli',
        }),
      (err) => err instanceof EvalError && err.code === 'EXPERIMENT_EXISTS',
    );

    assert.throws(
      () =>
        registry.registerExperiment({
          name: '   ',
          candidateModel: 'a',
          baselineModel: 'b',
          source: 'cli',
        }),
      (err) => err instanceof EvalError && err.code === 'INVALID_INPUT',
    );
  } finally {
    registry.close();
    tmp.cleanup();
  }
});

test('AT-P7-02: runEvalSuite runs reproducible $0 mock suite and records SHA-256 output hashes', async () => {
  const tmp = makeTempDb();
  const registry = openExperimentRegistry({ path: tmp.dbPath, now: makeClock() });
  try {
    const exp = registry.registerExperiment({
      name: 'mock-repro',
      candidateModel: 'cand-a',
      baselineModel: 'base-a',
      source: 'test-harness',
    });

    const tasks = [
      { id: 't1', objective: 'echo 1', expected_substring: 'mock:cand-a:t1' },
      { id: 't2', objective: 'echo 2', expected_substring: 'mock:cand-a:t2' },
      { id: 't3', objective: 'fail check', expected_substring: 'not-present' },
    ];

    const summary = await registry.runEvalSuite({
      experimentId: exp.id,
      modelId: 'cand-a',
      tasks,
      hostSnapshot: { cpu: 'ryzen', os: 'win32' },
    });

    assert.equal(summary.experiment_id, exp.id);
    assert.equal(summary.model_id, 'cand-a');
    assert.equal(summary.total, 3);
    assert.equal(summary.passed, 2);
    assert.equal(summary.failed, 1);
    assert.ok(Math.abs(summary.pass_rate - 2 / 3) < 1e-9);
    assert.equal(summary.total_cost, 0);
    assert.equal(summary.avg_latency_ms >= 0, true);

    const runs = registry.listRuns(exp.id);
    assert.equal(runs.length, 3);
    const expectedHashT1 = createHash('sha256').update('mock:cand-a:t1', 'utf8').digest('hex');
    assert.equal(runs[0]?.output_hash, expectedHashT1);
    assert.equal(runs[0]?.passed, true);
    assert.equal(runs[2]?.passed, false);
    assert.deepEqual(runs[0]?.host_snapshot, { cpu: 'ryzen', os: 'win32' });
  } finally {
    registry.close();
    tmp.cleanup();
  }
});

test('AT-P7-03: compareCandidates recommends insufficient_data, promote_candidate, or keep_baseline', async () => {
  const tmp = makeTempDb();
  const registry = openExperimentRegistry({ path: tmp.dbPath, now: makeClock() });
  try {
    const exp = registry.registerExperiment({
      id: 'cmp-1',
      name: 'compare-pass-rate',
      candidateModel: 'cand',
      baselineModel: 'base',
      source: 'cli',
    });

    assert.equal(registry.compareCandidates('cmp-1').recommendation, 'insufficient_data');

    const tasks = [
      { id: 't1', objective: 'q1', expected_substring: 'OK' },
      { id: 't2', objective: 'q2', expected_substring: 'OK' },
    ];

    await registry.runEvalSuite({
      experimentId: 'cmp-1',
      modelId: 'base',
      tasks,
      runner: async (task) => ({
        answer: task.id === 't1' ? 'OK' : 'NO',
        cost: 0.01,
        latency_ms: 20,
      }),
    });

    assert.equal(registry.compareCandidates('cmp-1').recommendation, 'insufficient_data');

    await registry.runEvalSuite({
      experimentId: 'cmp-1',
      modelId: 'cand',
      tasks,
      runner: async () => ({ answer: 'OK', cost: 0.02, latency_ms: 50 }),
    });

    const betterPass = registry.compareCandidates('cmp-1');
    assert.equal(betterPass.recommendation, 'promote_candidate');
    assert.equal(betterPass.baseline.pass_rate, 0.5);
    assert.equal(betterPass.candidate.pass_rate, 1);

    // Tie on pass_rate, faster candidate wins.
    const expTieFast = registry.registerExperiment({
      id: 'cmp-tie-fast',
      name: 'compare-latency-tiebreak',
      candidateModel: 'cand',
      baselineModel: 'base',
      source: 'cli',
    });
    await registry.runEvalSuite({
      experimentId: expTieFast.id,
      modelId: 'base',
      tasks: [{ id: 't1', objective: 'q1', expected_substring: 'OK' }],
      runner: () => ({ answer: 'OK', cost: 0, latency_ms: 40 }),
    });
    await registry.runEvalSuite({
      experimentId: expTieFast.id,
      modelId: 'cand',
      tasks: [{ id: 't1', objective: 'q1', expected_substring: 'OK' }],
      runner: () => ({ answer: 'OK', cost: 0, latency_ms: 15 }),
    });
    assert.equal(registry.compareCandidates(expTieFast.id).recommendation, 'promote_candidate');

    // Worse or slower-on-tie keeps baseline.
    const expKeep = registry.registerExperiment({
      id: 'cmp-keep',
      name: 'compare-keep',
      candidateModel: 'cand',
      baselineModel: 'base',
      source: 'cli',
    });
    await registry.runEvalSuite({
      experimentId: expKeep.id,
      modelId: 'base',
      tasks: [{ id: 't1', objective: 'q1', expected_substring: 'OK' }],
      runner: () => ({ answer: 'OK', cost: 0, latency_ms: 10 }),
    });
    await registry.runEvalSuite({
      experimentId: expKeep.id,
      modelId: 'cand',
      tasks: [{ id: 't1', objective: 'q1', expected_substring: 'OK' }],
      runner: () => ({ answer: 'OK', cost: 0, latency_ms: 25 }),
    });
    assert.equal(registry.compareCandidates(expKeep.id).recommendation, 'keep_baseline');
  } finally {
    registry.close();
    tmp.cleanup();
  }
});

test('AT-P7-04: rollbackExperiment is atomic and blocks further runs or re-rollbacks', async () => {
  const tmp = makeTempDb();
  const registry = openExperimentRegistry({ path: tmp.dbPath, now: makeClock() });
  try {
    const exp = registry.registerExperiment({
      id: 'rb-1',
      name: 'rollback-test',
      candidateModel: 'cand',
      baselineModel: 'base',
      source: 'cli',
    });

    assert.throws(
      () => registry.rollbackExperiment(exp.id, { rolledBackBy: '   ' }),
      (err) => err instanceof EvalError && err.code === 'INVALID_INPUT',
    );

    const rolled = registry.rollbackExperiment(exp.id, {
      rolledBackBy: 'operator-1',
      reason: 'regression in tool calling',
    });
    assert.equal(rolled.status, 'rolled_back');
    assert.equal(rolled.rolled_back_by, 'operator-1');
    assert.equal(rolled.rollback_reason, 'regression in tool calling');
    assert.ok(rolled.rolled_back_at);

    await assert.rejects(
      () =>
        registry.runEvalSuite({
          experimentId: exp.id,
          modelId: 'cand',
          tasks: [{ id: 't1', objective: 'q1' }],
        }),
      (err) => err instanceof EvalError && err.code === 'EXPERIMENT_ROLLED_BACK',
    );

    assert.throws(
      () => registry.rollbackExperiment(exp.id, { rolledBackBy: 'operator-2' }),
      (err) => err instanceof EvalError && err.code === 'ALREADY_ROLLED_BACK',
    );

    assert.throws(
      () => registry.rollbackExperiment('does-not-exist', { rolledBackBy: 'operator-1' }),
      (err) => err instanceof EvalError && err.code === 'EXPERIMENT_NOT_FOUND',
    );
  } finally {
    registry.close();
    tmp.cleanup();
  }
});

test('AT-P7-05: experiments and eval runs persist across close and reopen', async () => {
  const tmp = makeTempDb();
  const reg1 = openExperimentRegistry({ path: tmp.dbPath, now: makeClock() });
  try {
    reg1.registerExperiment({
      id: 'persist-1',
      name: 'persisted-exp',
      candidateModel: 'cand',
      baselineModel: 'base',
      source: 'cli',
    });
    await reg1.runEvalSuite({
      experimentId: 'persist-1',
      modelId: 'base',
      tasks: [{ id: 't1', objective: 'hello', expected_substring: 'mock:base:t1' }],
    });
    await reg1.runEvalSuite({
      experimentId: 'persist-1',
      modelId: 'cand',
      tasks: [{ id: 't1', objective: 'hello', expected_substring: 'never' }],
    });
    reg1.rollbackExperiment('persist-1', { rolledBackBy: 'qa', reason: 'done' });
  } finally {
    reg1.close();
  }

  const reg2 = openExperimentRegistry({ path: tmp.dbPath, now: makeClock() });
  try {
    const loaded = reg2.get('persist-1');
    assert.ok(loaded);
    assert.equal(loaded.status, 'rolled_back');
    assert.equal(loaded.rolled_back_by, 'qa');

    const runs = reg2.listRuns('persist-1');
    assert.equal(runs.length, 2);

    const cmp = reg2.compareCandidates('persist-1');
    assert.equal(cmp.status, 'rolled_back');
    assert.equal(cmp.recommendation, 'keep_baseline');
  } finally {
    reg2.close();
    tmp.cleanup();
  }
});

test('AT-P7-06: runEvalSuite rejects missing experiments and empty tasks', async () => {
  const tmp = makeTempDb();
  const registry = openExperimentRegistry({ path: tmp.dbPath });
  try {
    await assert.rejects(
      () =>
        registry.runEvalSuite({
          experimentId: 'missing',
          modelId: 'm1',
          tasks: [{ id: 't1', objective: 'o1' }],
        }),
      (err) => err instanceof EvalError && err.code === 'EXPERIMENT_NOT_FOUND',
    );

    const exp = registry.registerExperiment({
      id: 'valid',
      name: 'valid',
      candidateModel: 'c',
      baselineModel: 'b',
      source: 'cli',
    });

    await assert.rejects(
      () =>
        registry.runEvalSuite({
          experimentId: exp.id,
          modelId: 'c',
          tasks: [],
        }),
      (err) => err instanceof EvalError && err.code === 'INVALID_TASKS',
    );
  } finally {
    registry.close();
    tmp.cleanup();
  }
});
