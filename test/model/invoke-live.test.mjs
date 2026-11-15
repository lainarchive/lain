/**
 * @generated
 * @purpose  M-7 tests: the invoke --live approval loop — engine gate, ledger lookup, credential, and the transport behind an injected fetch
 * @requires Chief-of-Staff
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { modelInvokeCommand } from '../../src/cli/commands/model-invoke.mjs';
import { createPersistentLedger } from '../../src/model/persistentLedger.mjs';

const ROOT = mkdtempSync(join(tmpdir(), 'lain-m7-invoke-live-'));
const LEDGER = join(ROOT, 'approvals.db');

test.after(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

/**
 * Seed the persistent ledger with one approval record. The ledger's own gate
 * is honoured here: the test acts as the operator holding model.admin.
 *
 * @param {string} decisionId
 * @param {'pending' | 'granted' | 'denied' | 'timed_out'} outcome
 */
function seedApproval(decisionId, outcome) {
  const ledger = createPersistentLedger(LEDGER);
  try {
    ledger.add({ decision_id: decisionId, taskId: 'task-live-1', modelId: 'gemini', outcome }, { granted_capabilities: ['model.admin'] });
  } finally {
    ledger.close();
  }
}

/**
 * Run one command invocation with captured io and an injected fetch.
 *
 * @param {{ positional: string[], flags?: Record<string, string|boolean>, fetchImpl?: typeof fetch }} invocation
 * @returns {Promise<{ exit: number, stdout: string, stderr: string }>}
 */
async function runLive({ positional, flags = {}, fetchImpl }) {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const err = [];
  const exit = await modelInvokeCommand({
    command: 'invoke',
    positional,
    flags,
    io: { out: (line) => out.push(line), err: (line) => err.push(line) },
    fetchImpl,
  });
  return { exit, stdout: out.join('\n'), stderr: err.join('\n') };
}

function writeTask(name, body) {
  const path = join(ROOT, name);
  writeFileSync(path, JSON.stringify(body));
  return path;
}

/** A fetch that never touches the network and records nothing. */
const noFetch = /** @type {typeof fetch} */ (async () => {
  throw new Error('no network may be reached in this test');
});

test('AT-M7-27: --live without an approval is A5 — the engine asks a human, nothing runs', async () => {
  const task = writeTask('no-approval.json', { prompt: 'hello', granted_capabilities: ['model.invoke.external'] });
  const result = await runLive({ positional: [task, 'gemini'], flags: { live: true }, fetchImpl: noFetch });
  assert.equal(result.exit, 3);
  assert.match(result.stderr, /A5 require_approval/);
  assert.equal(result.stdout, '');
});

test('AT-M7-28: --approval without --ledger is a usage error', async () => {
  const task = writeTask('no-ledger.json', { prompt: 'hello', granted_capabilities: ['model.invoke.external'] });
  const result = await runLive({ positional: [task, 'gemini'], flags: { live: true, approval: '01M7E8X' }, fetchImpl: noFetch });
  assert.equal(result.exit, 2);
  assert.match(result.stderr, /--approval needs --ledger/);
});

test('AT-M7-29: a ledger path that does not exist is a failure, not a silent grant', async () => {
  const task = writeTask('missing-ledger.json', { prompt: 'hello', granted_capabilities: ['model.invoke.external'] });
  const result = await runLive({
    positional: [task, 'gemini'],
    flags: { live: true, approval: '01M7E8X', ledger: join(ROOT, 'no-such.db') },
    fetchImpl: noFetch,
  });
  assert.equal(result.exit, 4);
  assert.match(result.stderr, /ledger not found/);
});

test('AT-M7-30: a recorded granted approval turns A5 into A5b and the transport runs', async () => {
  seedApproval('01M7E8GRANTEDLIVE', 'granted');
  const task = writeTask('granted.json', { prompt: 'hello', granted_capabilities: ['model.invoke.external'] });
  const previous = process.env.AGY_ACCOUNT;
  process.env.AGY_ACCOUNT = 'ai-test-abcdef123456';
  try {
    /** @type {Array<{ url: string, init: RequestInit }>} */
    const calls = [];
    const fetchImpl = /** @type {typeof fetch} */ (async (url, init) => {
      calls.push({ url: /** @type {string} */ (url), init: /** @type {RequestInit} */ (init) });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'live-answer' }] } }] }), { status: 200 });
    });
    const result = await runLive({
      positional: [task, 'gemini'],
      flags: { live: true, approval: '01M7E8GRANTEDLIVE', ledger: LEDGER },
      fetchImpl,
    });
    assert.equal(result.exit, 0);
    const doc = JSON.parse(result.stdout);
    assert.equal(doc.live, true);
    assert.equal(doc.approval_id, '01M7E8GRANTEDLIVE');
    assert.equal(doc.answer, 'live-answer');
    assert.equal(doc.credentials.apiKey, '****3456', 'the key is reported masked, never raw');
    assert.equal(calls.length, 1, 'the transport ran exactly once');
  } finally {
    if (previous === undefined) {
      delete process.env.AGY_ACCOUNT;
    } else {
      process.env.AGY_ACCOUNT = previous;
    }
  }
});

test('AT-M7-31: a denied approval is A1 — refused terminally even though a record exists', async () => {
  seedApproval('01M7E8DENIEDLIVE', 'denied');
  const task = writeTask('denied.json', { prompt: 'hello', granted_capabilities: ['model.invoke.external'] });
  const result = await runLive({
    positional: [task, 'gemini'],
    flags: { live: true, approval: '01M7E8DENIEDLIVE', ledger: LEDGER },
    fetchImpl: noFetch,
  });
  assert.equal(result.exit, 3);
  assert.match(result.stderr, /A1 /);
  assert.equal(result.stdout, '');
});

test('AT-M7-32: a pending approval is not a yes — the engine still asks', async () => {
  seedApproval('01M7E8PENDINGLV', 'pending');
  const task = writeTask('pending.json', { prompt: 'hello', granted_capabilities: ['model.invoke.external'] });
  const result = await runLive({
    positional: [task, 'gemini'],
    flags: { live: true, approval: '01M7E8PENDINGLV', ledger: LEDGER },
    fetchImpl: noFetch,
  });
  assert.equal(result.exit, 3);
  assert.match(result.stderr, /A5 require_approval/);
});

test('AT-M7-33: an approval id the ledger does not know is not a yes', async () => {
  seedApproval('01M7E8KNOWNID01', 'granted');
  const task = writeTask('unknown-id.json', { prompt: 'hello', granted_capabilities: ['model.invoke.external'] });
  const result = await runLive({
    positional: [task, 'gemini'],
    flags: { live: true, approval: '01M7E8UNKNOWNID', ledger: LEDGER },
    fetchImpl: noFetch,
  });
  assert.equal(result.exit, 3);
  assert.match(result.stderr, /A5 require_approval/);
});

test('AT-M7-34: a granted approval must not substitute for the capability the task lacks', async () => {
  seedApproval('01M7E8GRANTEDLV2', 'granted');
  const task = writeTask('ungranted.json', { prompt: 'hello', granted_capabilities: ['model.invoke'] });
  const result = await runLive({
    positional: [task, 'gemini'],
    flags: { live: true, approval: '01M7E8GRANTEDLV2', ledger: LEDGER },
    fetchImpl: noFetch,
  });
  assert.equal(result.exit, 3);
  assert.match(result.stderr, /CAPABILITY_NOT_GRANTED/, 'A6b outranks A5b: no capability, no run');
  assert.equal(result.stdout, '');
});

test('AT-M7-35: openai --live runs only when the account is funded, then behaves like gemini', async () => {
  seedApproval('01M7E8GRANTEDOAI', 'granted');
  const task = writeTask('openai-live.json', { prompt: 'hello', granted_capabilities: ['model.invoke.external'] });
  const previousKey = process.env.AGY_ACCOUNT;
  const previousFunded = process.env.OPENAI_FUNDED;
  process.env.AGY_ACCOUNT = 'sk-test-abcdef123456';
  process.env.OPENAI_FUNDED = '1';
  try {
    const fetchImpl = /** @type {typeof fetch} */ (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'live-openai-answer' } }] }), { status: 200 }));
    const result = await runLive({
      positional: [task, 'openai'],
      flags: { live: true, approval: '01M7E8GRANTEDOAI', ledger: LEDGER },
      fetchImpl,
    });
    assert.equal(result.exit, 0);
    const doc = JSON.parse(result.stdout);
    assert.equal(doc.provider, 'openai');
    assert.equal(doc.answer, 'live-openai-answer');
    assert.equal(doc.credentials.apiKey, '****3456');
  } finally {
    if (previousKey === undefined) {
      delete process.env.AGY_ACCOUNT;
    } else {
      process.env.AGY_ACCOUNT = previousKey;
    }
    if (previousFunded === undefined) {
      delete process.env.OPENAI_FUNDED;
    } else {
      process.env.OPENAI_FUNDED = previousFunded;
    }
  }
});

test('AT-M7-36: a missing credential is refused before the transport is built', async () => {
  seedApproval('01M7E8GRANTEDKEY', 'granted');
  const task = writeTask('no-key.json', { prompt: 'hello', granted_capabilities: ['model.invoke.external'] });
  const previous = process.env.AGY_ACCOUNT;
  delete process.env.AGY_ACCOUNT;
  try {
    const result = await runLive({
      positional: [task, 'gemini'],
      flags: { live: true, approval: '01M7E8GRANTEDKEY', ledger: LEDGER },
      fetchImpl: noFetch,
    });
    assert.equal(result.exit, 3);
    assert.match(result.stderr, /no credential for gemini/);
  } finally {
    if (previous === undefined) {
      delete process.env.AGY_ACCOUNT;
    } else {
      process.env.AGY_ACCOUNT = previous;
    }
  }
});
