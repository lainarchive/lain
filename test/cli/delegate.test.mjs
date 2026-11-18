import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { delegateCommand } from '../../src/cli/commands/delegate.mjs';
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

async function withTempTask(body, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'lain-delegate-cli-'));
  try {
    const taskPath = join(dir, 'task.json');
    writeFileSync(taskPath, typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    return await fn(taskPath, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('delegateCommand returns usage (2) on unknown subcommand', async () => {
  const { err, io } = makeIo();
  const code = await delegateCommand({ command: 'unknown', positional: [], flags: {}, io });
  assert.equal(code, EXIT.usage);
  assert.match(err.join('\n'), /lain delegate list/);
});

test('delegateCommand list outputs specialists in text and --json', async () => {
  const plain = makeIo();
  const code1 = await delegateCommand({ command: 'list', positional: [], flags: {}, io: plain.io });
  assert.equal(code1, EXIT.ok);
  const text = plain.out.join('\n');
  assert.match(text, /researcher/);
  assert.match(text, /implementer/);
  assert.match(text, /verifier/);

  const jsonIo = makeIo();
  const code2 = await delegateCommand({ command: 'list', positional: [], flags: { json: true }, io: jsonIo.io });
  assert.equal(code2, EXIT.ok);
  const rows = JSON.parse(jsonIo.out.join('\n'));
  assert.equal(Array.isArray(rows), true);
  assert.deepEqual(rows.map((r) => r.id), ['researcher', 'implementer', 'verifier']);
  for (const row of rows) {
    assert.equal(Array.isArray(row.allowed_capabilities), true);
    assert.equal(typeof row.max_steps, 'number');
    assert.equal(typeof row.max_model_calls, 'number');
    assert.equal(typeof row.max_tool_calls, 'number');
  }
});

test('delegateCommand run returns usage (2) when --task is missing or --depth is invalid', async () => {
  const missingTask = makeIo();
  const code1 = await delegateCommand({ command: 'run', positional: [], flags: {}, io: missingTask.io });
  assert.equal(code1, EXIT.usage);
  assert.match(missingTask.err.join('\n'), /lain delegate run --task/);

  await withTempTask({ id: 't-1', objective: 'check status', granted_capabilities: ['model.invoke'] }, async (taskPath) => {
    const badDepth = makeIo();
    const code2 = await delegateCommand({
      command: 'run',
      positional: [],
      flags: { task: taskPath, depth: '-1' },
      io: badDepth.io,
    });
    assert.equal(code2, EXIT.usage);
    assert.match(badDepth.err.join('\n'), /--depth/);
  });
});

test('delegateCommand run returns usage (2) on unreadable or invalid task JSON', async () => {
  const missing = makeIo();
  const code1 = await delegateCommand({
    command: 'run',
    positional: [],
    flags: { task: join(tmpdir(), 'nonexistent-lain-delegate-task-99999.json') },
    io: missing.io,
  });
  assert.equal(code1, EXIT.usage);
  assert.match(missing.err.join('\n'), /cannot read task file/);

  await withTempTask('{not-json', async (badPath) => {
    const bad = makeIo();
    const code2 = await delegateCommand({
      command: 'run',
      positional: [],
      flags: { task: badPath },
      io: bad.io,
    });
    assert.equal(code2, EXIT.usage);
    assert.match(bad.err.join('\n'), /cannot read task file/);
  });
});

test('delegateCommand run returns refused (3) when delegation depth is exceeded', async () => {
  await withTempTask(
    { id: 't-refuse', objective: 'check status', granted_capabilities: ['model.invoke'] },
    async (taskPath) => {
      const { out, io } = makeIo();
      const code = await delegateCommand({
        command: 'run',
        positional: [],
        flags: { task: taskPath, depth: '2', json: true },
        io,
      });
      assert.equal(code, EXIT.refused);
      const parsed = JSON.parse(out.join('\n'));
      assert.equal(parsed.status, 'refused');
      assert.equal(parsed.reason, 'DELEGATION_DEPTH_EXCEEDED');
    },
  );
});

test('delegateCommand run completes $0 mock happy path (exit 0)', async () => {
  await withTempTask(
    {
      id: 't-ok',
      prompt: 'summarise status',
      granted_capabilities: ['model.invoke'],
      context_notes: 'phase 5 check',
    },
    async (taskPath) => {
      const jsonIo = makeIo();
      const code1 = await delegateCommand({
        command: 'run',
        positional: [],
        flags: { task: taskPath, specialist: 'verifier', json: true },
        io: jsonIo.io,
      });
      assert.equal(code1, EXIT.ok);
      const parsed = JSON.parse(jsonIo.out.join('\n'));
      assert.equal(parsed.status, 'completed');
      assert.equal(parsed.specialist, 'verifier');
      assert.equal(parsed.depth, 1);
      assert.equal(parsed.outcome.answer, 'mock-ok');

      const plainIo = makeIo();
      const code2 = await delegateCommand({
        command: 'run',
        positional: [],
        flags: { task: taskPath },
        io: plainIo.io,
      });
      assert.equal(code2, EXIT.ok);
      assert.match(plainIo.out.join('\n'), /status\s+completed/);
    },
  );
});
