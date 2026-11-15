/**
 * @generated
 * @purpose  M-4 tests: the provider loader resolves registered models and refuses the rest
 * @requires Chief-of-Staff
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadProvider, ProviderNotFound } from '../../src/model/provider.mjs';
import { localModel } from '../../src/model/localModel.mjs';

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
