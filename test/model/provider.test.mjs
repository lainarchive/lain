// The provider loader resolves registered models and refuses the rest
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProvider, ProviderNotFound } from '../../src/model/provider.mjs';
import { loadProviderFromDb } from '../../src/model/provider/sqlite.mjs';
import { localModel } from '../../src/model/localModel.mjs';

/** The SQLite module under test, resolved the same way probe.mjs resolves it. */
function getSqlite() {
  return /** @type {{ DatabaseSync: typeof import('node:sqlite').DatabaseSync }} */ (
    /** @type {any} */ (globalThis).process.getBuiltinModule('node:sqlite')
  );
}

const ROOT = mkdtempSync(join(tmpdir(), 'lain-m6-provider-'));

test.after(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

test('AT-M4-01: loadProvider resolves local-mock to the mock invoke function', async () => {
  const invoke = await loadProvider('local-mock');
  assert.equal(invoke, localModel, 'the loader must return the same function the module exports');
  const result = invoke('ping');
  assert.deepEqual(result, { answer: 'mock-response', echo: 'ping' });
});

test('AT-M4-02: loadProvider refuses an unknown model id', async () => {
  await assert.rejects(() => loadProvider('no-such-model'), (err) => {
    assert.ok(err instanceof ProviderNotFound);
    assert.equal(err.code, 'PROVIDER_NOT_FOUND');
    return true;
  });
});

test('AT-M4-03: loadProvider refuses a registered model whose provider kind has no loader', async () => {
  const registry = {
    'quantum-mock': { id: 'quantum-mock', provider: 'quantum', name: 'q', cost: 1, effect_class: 'external' },
  };
  await assert.rejects(() => loadProvider('quantum-mock', { registry }), (err) => {
    assert.ok(err instanceof ProviderNotFound);
    assert.equal(err.code, 'PROVIDER_NOT_FOUND');
    return true;
  });
});

test('AT-M5-01: the OpenAI stub answers with its fixed mock payload', async () => {
  const { query } = await import('../../src/model/provider/openai.mjs');
  const result = query('hello');
  assert.deepEqual(result, { provider: 'openai', answer: 'mock-openai-response', echo: 'hello' });
});

test('AT-M5-02: the OpenAI stub echoes the prompt unchanged', async () => {
  const { query } = await import('../../src/model/provider/openai.mjs');
  assert.equal(query('a different prompt').echo, 'a different prompt');
});

test('AT-M5-03: the Gemini stub answers with its fixed mock payload', async () => {
  const { query } = await import('../../src/model/provider/gemini.mjs');
  const result = query('hello');
  assert.deepEqual(result, { provider: 'gemini', answer: 'mock-gemini-response', echo: 'hello' });
});

test('AT-M5-04: the two stubs are distinguishable by their provider marker', async () => {
  const openai = await import('../../src/model/provider/openai.mjs');
  const gemini = await import('../../src/model/provider/gemini.mjs');
  assert.notEqual(openai.query('x').provider, gemini.query('x').provider);
});

test('AT-M6-13: a providers.db binding resolves to a mock invoke that echoes the prompt', () => {
  const dbPath = join(ROOT, 'bindings.db');
  const { DatabaseSync } = getSqlite();
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE IF NOT EXISTS provider_bindings (model_id TEXT PRIMARY KEY, provider TEXT NOT NULL, endpoint TEXT NOT NULL)');
  db.prepare('INSERT INTO provider_bindings (model_id, provider, endpoint) VALUES (?, ?, ?)').run('db-mock', 'openai', 'https://mock.invalid/v1');
  db.close();
  const binding = loadProviderFromDb(dbPath, 'db-mock');
  assert.equal(binding.provider, 'openai');
  assert.equal(binding.endpoint, 'https://mock.invalid/v1');
  assert.deepEqual(binding.invoke('ping'), { provider: 'openai', answer: 'mock-db-response', echo: 'ping' });
});

test('AT-M6-14: a missing providers database is ProviderDBNotFound, and the failed load creates no file', () => {
  const dbPath = join(ROOT, 'not-there.db');
  assert.equal(existsSync(dbPath), false);
  assert.throws(() => loadProviderFromDb(dbPath, 'db-mock'), (err) => {
    assert.equal(err.code, 'PROVIDER_DB_NOT_FOUND');
    return true;
  });
  assert.equal(existsSync(dbPath), false, 'a refused load must not leave an empty database behind');
});

test('AT-M6-15: an existing database without the requested binding is ProviderNotFound', () => {
  const dbPath = join(ROOT, 'bindings.db');
  assert.throws(() => loadProviderFromDb(dbPath, 'no-such-model'), (err) => {
    assert.ok(err instanceof ProviderNotFound);
    assert.equal(err.code, 'PROVIDER_NOT_FOUND');
    return true;
  });
});
