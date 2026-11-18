import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { modelLoopCommand } from '../../src/cli/commands/model-loop.mjs';
import { EXIT, main } from '../../src/cli/index.mjs';

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
  const dir = mkdtempSync(join(tmpdir(), 'lain-model-loop-'));
  try {
    const taskPath = join(dir, 'task.json');
    writeFileSync(taskPath, typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    return await fn(taskPath, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('modelLoopCommand returns usage (2) when --task is missing', async () => {
  const { err, io } = makeIo();
  const code = await modelLoopCommand({ command: 'loop', positional: [], flags: {}, io });
  assert.equal(code, EXIT.usage);
  assert.match(err.join('\n'), /lain model loop --task/);
});

test('modelLoopCommand returns usage (2) when --live is set without --approval-id and --ledger', async () => {
  await withTempTask({ id: 't-1', objective: 'say hi', granted_capabilities: ['model.invoke'] }, async (taskPath) => {
    const first = makeIo();
    const code1 = await modelLoopCommand({
      command: 'loop',
      positional: [],
      flags: { task: taskPath, live: true },
      io: first.io,
    });
    assert.equal(code1, EXIT.usage);
    assert.match(first.err.join('\n'), /lain model loop --task/);

    const second = makeIo();
    const code2 = await modelLoopCommand({
      command: 'loop',
      positional: [],
      flags: { task: taskPath, live: true, 'approval-id': 'dec-1' },
      io: second.io,
    });
    assert.equal(code2, EXIT.usage);
    assert.match(second.err.join('\n'), /lain model loop --task/);
  });
});

test('modelLoopCommand returns usage (2) on unreadable or invalid task JSON', async () => {
  const missing = makeIo();
  const code1 = await modelLoopCommand({
    command: 'loop',
    positional: [],
    flags: { task: join(tmpdir(), 'nonexistent-lain-task-99999.json') },
    io: missing.io,
  });
  assert.equal(code1, EXIT.usage);
  assert.match(missing.err.join('\n'), /cannot read task file/);

  await withTempTask('{not-json', async (badPath) => {
    const bad = makeIo();
    const code2 = await modelLoopCommand({
      command: 'loop',
      positional: [],
      flags: { task: badPath },
      io: bad.io,
    });
    assert.equal(code2, EXIT.usage);
    assert.match(bad.err.join('\n'), /cannot read task file/);
  });
});

test('modelLoopCommand returns refused (3) when model.invoke capability is not granted', async () => {
  await withTempTask({ id: 't-refuse', objective: 'say hi', granted_capabilities: [] }, async (taskPath) => {
    const { out, io } = makeIo();
    const code = await modelLoopCommand({
      command: 'loop',
      positional: [],
      flags: { task: taskPath, json: true },
      io,
    });
    assert.equal(code, EXIT.refused);
    const parsed = JSON.parse(out.join('\n'));
    assert.equal(parsed.status, 'refused');
  });
});

test('modelLoopCommand completes $0 mock happy path (exit 0) and wires through CLI main', async () => {
  await withTempTask({ id: 't-ok', prompt: 'summarise status', granted_capabilities: ['model.invoke'] }, async (taskPath) => {
    const direct = makeIo();
    const code = await modelLoopCommand({
      command: 'loop',
      positional: [],
      flags: { task: taskPath, json: true },
      io: direct.io,
    });
    assert.equal(code, EXIT.ok);
    const parsed = JSON.parse(direct.out.join('\n'));
    assert.equal(parsed.status, 'completed');
    assert.equal(parsed.answer, 'mock-ok');

    const viaCli = makeIo();
    const cliCode = await main(['model', 'loop', '--task', taskPath], viaCli.io);
    assert.equal(cliCode, EXIT.ok);
    assert.match(viaCli.out.join('\n'), /status\s+completed/);
  });
});
