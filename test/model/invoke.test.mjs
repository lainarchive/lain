/**
 * @generated
 * @purpose  M-7 tests: the invoke command routes to stubs, keeps the live transports behind the funding gate, and gates through the engine
 * @requires Chief-of-Staff
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { modelInvokeCommand } from '../../src/cli/commands/model-invoke.mjs';
import { modelCredentialsCommand } from '../../src/cli/commands/model-credentials.mjs';

const ROOT = mkdtempSync(join(tmpdir(), 'lain-m7-invoke-'));

/**
 * The io shape every command handler accepts, with output captured.
 *
 * @typedef {{ out: (line: string) => void, err: (line: string) => void }} CaptureIo
 */

test.after(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

/**
 * Run one command invocation with captured io.
 *
 * @param {(args: { command?: string, positional: string[], flags: Record<string, string|boolean>, io: CaptureIo }) => Promise<number> | number} handler
 * @param {{ positional: string[], flags?: Record<string, string|boolean>, command?: string }} invocation
 * @returns {Promise<{ exit: number, stdout: string, stderr: string }>}
 */
async function run(handler, { positional, flags = {}, command }) {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const err = [];
  const exit = await handler({
    command,
    positional,
    flags,
    io: { out: (line) => out.push(line), err: (line) => err.push(line) },
  });
  return { exit, stdout: out.join('\n'), stderr: err.join('\n') };
}

function writeTask(name, body) {
  const path = join(ROOT, name);
  writeFileSync(path, JSON.stringify(body));
  return path;
}

test('AT-M7-09: an unknown provider is a failure, not a crash', async () => {
  const task = writeTask('unknown-provider.json', { prompt: 'ping', granted_capabilities: ['model.invoke'] });
  const result = await run(modelInvokeCommand, { command: 'invoke', positional: [task, 'anthropic'] });
  assert.equal(result.exit, 4);
  assert.match(result.stderr, /unknown provider: anthropic/);
});

test('AT-M7-10: the openai stub answers through the gate with a masked credential status', async () => {
  const task = writeTask('openai.json', { prompt: 'hello', granted_capabilities: ['model.invoke'] });
  const result = await run(modelInvokeCommand, { command: 'invoke', positional: [task, 'openai'] });
  assert.equal(result.exit, 0);
  const doc = JSON.parse(result.stdout);
  assert.equal(doc.provider, 'openai');
  assert.equal(doc.answer, 'mock-openai-response');
  assert.equal(doc.echo, 'hello');
  assert.equal(doc.credentials.source, 'none');
  assert.equal(doc.credentials.apiKey, '(absent)');
});

test('AT-M7-11: the gemini stub answers with its own marker', async () => {
  const task = writeTask('gemini.json', { prompt: 'hello', granted_capabilities: ['model.invoke'] });
  const result = await run(modelInvokeCommand, { command: 'invoke', positional: [task, 'gemini'] });
  assert.equal(result.exit, 0);
  const doc = JSON.parse(result.stdout);
  assert.equal(doc.provider, 'gemini');
  assert.equal(doc.answer, 'mock-gemini-response');
});

test('AT-M7-12: openai --live is refused while the account is unfunded — no network, no exception', async () => {
  const task = writeTask('live.json', { prompt: 'hello', granted_capabilities: ['model.invoke.external'] });
  const previous = process.env.OPENAI_FUNDED;
  delete process.env.OPENAI_FUNDED;
  try {
    const result = await run(modelInvokeCommand, { command: 'invoke', positional: [task, 'openai'], flags: { live: true } });
    assert.equal(result.exit, 3);
    assert.match(result.stderr, /no free api tier/);
    assert.equal(result.stdout, '', 'a refused invocation prints no result document');
  } finally {
    if (previous === undefined) {
      delete process.env.OPENAI_FUNDED;
    } else {
      process.env.OPENAI_FUNDED = previous;
    }
  }
});

test('AT-M7-13: without the model.invoke capability the engine refuses', async () => {
  const task = writeTask('ungated.json', { prompt: 'hello', granted_capabilities: [] });
  const result = await run(modelInvokeCommand, { command: 'invoke', positional: [task, 'openai'] });
  assert.equal(result.exit, 3);
  assert.match(result.stderr, /CAPABILITY_NOT_GRANTED/);
});

test('AT-M7-14: an unreadable task file is a usage error', async () => {
  const result = await run(modelInvokeCommand, { command: 'invoke', positional: [join(ROOT, 'no-such.json'), 'openai'] });
  assert.equal(result.exit, 2);
  assert.match(result.stderr, /cannot read task file/);
});

test('AT-M7-15: the credentials list reports every provider masked', async () => {
  const result = await run(modelCredentialsCommand, { command: 'credentials', positional: ['list'] });
  assert.equal(result.exit, 0);
  const doc = JSON.parse(result.stdout);
  assert.deepEqual(doc.credentials.map((entry) => entry.provider), ['openai', 'gemini']);
  for (const entry of doc.credentials) {
    assert.equal(entry.source, 'none');
    assert.equal(entry.apiKey, '(absent)');
  }
});

test('AT-M7-16: the credentials command takes no other verb', async () => {
  const result = await run(modelCredentialsCommand, { command: 'credentials', positional: ['set'] });
  assert.equal(result.exit, 2);
});
