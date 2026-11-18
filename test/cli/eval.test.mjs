import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evalCommand } from '../../src/cli/commands/eval.mjs';
import { EXIT } from '../../src/cli/index.mjs';

function makeIo() {
  const out = [];
  const err = [];
  return {
    out,
    err,
    io: {
      out: (line) => out.push(String(line)),
      err: (line) => err.push(String(line)),
    },
  };
}

function sampleTasks() {
  return [
    { id: 't1', objective: 'Greet user', expected_substring: 'mock:' },
    { id: 't2', objective: 'Summarize file', expected_substring: ':t2' },
  ];
}

async function withTempEnv(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'lain-eval-cli-'));
  try {
    const dbPath = join(dir, 'eval.db');
    const tasksPath = join(dir, 'tasks.json');
    writeFileSync(tasksPath, JSON.stringify(sampleTasks()), 'utf8');
    return await fn({ dir, dbPath, tasksPath });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('evalCommand returns usage (2) on unknown subcommand, bare --lain-home, and missing args', async () => {
  await withTempEnv(async ({ dir, dbPath, tasksPath }) => {
    const u1 = makeIo();
    assert.equal(await evalCommand({ command: 'unknown', positional: [], flags: {}, io: u1.io, dbPath }), EXIT.usage);
    assert.match(u1.err.join('\n'), /lain eval register/);

    const uBare1 = makeIo();
    assert.equal(await evalCommand({ command: 'list', positional: [], flags: { 'lain-home': true }, io: uBare1.io }), EXIT.usage);

    const uBare2 = makeIo();
    assert.equal(await evalCommand({ command: 'list', positional: [], flags: { 'lain-home': '' }, io: uBare2.io }), EXIT.usage);

    const uReg = makeIo();
    assert.equal(
      await evalCommand({ command: 'register', positional: [], flags: { name: 'exp1' }, io: uReg.io, dbPath }),
      EXIT.usage,
    );

    const uRun1 = makeIo();
    assert.equal(
      await evalCommand({ command: 'run', positional: [], flags: { model: 'm1', tasks: tasksPath }, io: uRun1.io, dbPath }),
      EXIT.usage,
    );

    const uRun2 = makeIo();
    assert.equal(
      await evalCommand({ command: 'run', positional: ['exp-1'], flags: { model: 'm1', tasks: join(dir, 'missing.json') }, io: uRun2.io, dbPath }),
      EXIT.usage,
    );
    assert.match(uRun2.err.join('\n'), /cannot read tasks file/);

    const badJsonPath = join(dir, 'bad.json');
    writeFileSync(badJsonPath, '{not-json', 'utf8');
    const uRun3 = makeIo();
    assert.equal(
      await evalCommand({ command: 'run', positional: ['exp-1'], flags: { model: 'm1', tasks: badJsonPath }, io: uRun3.io, dbPath }),
      EXIT.usage,
    );

    const emptyArrPath = join(dir, 'empty.json');
    writeFileSync(emptyArrPath, '[]', 'utf8');
    const uRun4 = makeIo();
    assert.equal(
      await evalCommand({ command: 'run', positional: ['exp-1'], flags: { model: 'm1', tasks: emptyArrPath }, io: uRun4.io, dbPath }),
      EXIT.usage,
    );

    const uCmp = makeIo();
    assert.equal(await evalCommand({ command: 'compare', positional: [], flags: {}, io: uCmp.io, dbPath }), EXIT.usage);

    const uRb = makeIo();
    assert.equal(await evalCommand({ command: 'rollback', positional: ['exp-1'], flags: {}, io: uRb.io, dbPath }), EXIT.usage);

    const uList = makeIo();
    assert.equal(await evalCommand({ command: 'list', positional: [], flags: { status: 'bogus' }, io: uList.io, dbPath }), EXIT.usage);
  });
});

test('evalCommand lifecycle: register -> run -> compare -> list -> rollback -> refusal (3)', async () => {
  await withTempEnv(async ({ dbPath, tasksPath }) => {
    const regIo = makeIo();
    assert.equal(
      await evalCommand({
        command: 'register',
        positional: [],
        flags: {
          id: 'exp-p7',
          name: 'Prompt v2',
          candidate: 'gemini-2.5-flash',
          baseline: 'gemini-2.0-flash',
          source: 'eval-suite',
          json: true,
        },
        io: regIo.io,
        dbPath,
      }),
      EXIT.ok,
    );
    const created = JSON.parse(regIo.out.join('\n'));
    assert.equal(created.id, 'exp-p7');
    assert.equal(created.status, 'active');

    // Duplicate experiment id -> exit 3 (refused)
    const dupIo = makeIo();
    assert.equal(
      await evalCommand({
        command: 'register',
        positional: [],
        flags: {
          id: 'exp-p7',
          name: 'Prompt v2 dup',
          candidate: 'gemini-2.5-flash',
          baseline: 'gemini-2.0-flash',
          source: 'eval-suite',
        },
        io: dupIo.io,
        dbPath,
      }),
      EXIT.refused,
    );
    assert.match(dupIo.err.join('\n'), /EXPERIMENT_EXISTS/);

    // Run baseline and candidate ($0 deterministic mock)
    const runBase = makeIo();
    assert.equal(
      await evalCommand({
        command: 'run',
        positional: ['exp-p7'],
        flags: { model: 'gemini-2.0-flash', tasks: tasksPath, json: true },
        io: runBase.io,
        dbPath,
      }),
      EXIT.ok,
    );
    const baseSummary = JSON.parse(runBase.out.join('\n'));
    assert.equal(baseSummary.total, 2);
    assert.equal(baseSummary.passed, 2);
    assert.equal(baseSummary.total_cost, 0);

    const runCand = makeIo();
    assert.equal(
      await evalCommand({
        command: 'run',
        positional: ['exp-p7'],
        flags: { model: 'gemini-2.5-flash', tasks: tasksPath },
        io: runCand.io,
        dbPath,
      }),
      EXIT.ok,
    );
    assert.match(runCand.out.join('\n'), /eval exp-p7 model=gemini-2.5-flash passed=2\/2/);

    // Compare
    const cmpIo = makeIo();
    assert.equal(
      await evalCommand({ command: 'compare', positional: ['exp-p7'], flags: { json: true }, io: cmpIo.io, dbPath }),
      EXIT.ok,
    );
    const cmpReport = JSON.parse(cmpIo.out.join('\n'));
    assert.ok(['promote_candidate', 'keep_baseline', 'insufficient_data'].includes(cmpReport.recommendation));

    const cmpPlain = makeIo();
    assert.equal(await evalCommand({ command: 'compare', positional: ['exp-p7'], flags: {}, io: cmpPlain.io, dbPath }), EXIT.ok);
    assert.match(cmpPlain.out.join('\n'), /recommendation/);

    // List active
    const listActive = makeIo();
    assert.equal(
      await evalCommand({ command: 'list', positional: [], flags: { status: 'active', json: true }, io: listActive.io, dbPath }),
      EXIT.ok,
    );
    const activeRows = JSON.parse(listActive.out.join('\n'));
    assert.equal(activeRows.length, 1);
    assert.equal(activeRows[0].id, 'exp-p7');

    // Rollback
    const rbIo = makeIo();
    assert.equal(
      await evalCommand({
        command: 'rollback',
        positional: ['exp-p7'],
        flags: { by: 'release-eng', reason: 'latency regression', json: true },
        io: rbIo.io,
        dbPath,
      }),
      EXIT.ok,
    );
    const rolledBack = JSON.parse(rbIo.out.join('\n'));
    assert.equal(rolledBack.status, 'rolled_back');
    assert.equal(rolledBack.rolled_back_by, 'release-eng');

    // Refusal after rollback (exit 3): run and re-rollback
    const runAfterRb = makeIo();
    assert.equal(
      await evalCommand({
        command: 'run',
        positional: ['exp-p7'],
        flags: { model: 'gemini-2.5-flash', tasks: tasksPath },
        io: runAfterRb.io,
        dbPath,
      }),
      EXIT.refused,
    );
    assert.match(runAfterRb.err.join('\n'), /EXPERIMENT_ROLLED_BACK/);

    const reRb = makeIo();
    assert.equal(
      await evalCommand({
        command: 'rollback',
        positional: ['exp-p7'],
        flags: { by: 'release-eng' },
        io: reRb.io,
        dbPath,
      }),
      EXIT.refused,
    );
    assert.match(reRb.err.join('\n'), /ALREADY_ROLLED_BACK/);

    // List rolled_back
    const listRb = makeIo();
    assert.equal(
      await evalCommand({ command: 'list', positional: [], flags: { status: 'rolled_back' }, io: listRb.io, dbPath }),
      EXIT.ok,
    );
    assert.match(listRb.out.join('\n'), /exp-p7\s+\[rolled_back\]/);

    // Missing experiment -> exit 4 (failed)
    const missingIo = makeIo();
    assert.equal(
      await evalCommand({ command: 'compare', positional: ['does-not-exist'], flags: {}, io: missingIo.io, dbPath }),
      EXIT.failed,
    );
    assert.match(missingIo.err.join('\n'), /EXPERIMENT_NOT_FOUND/);
  });
});
