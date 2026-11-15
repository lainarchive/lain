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
