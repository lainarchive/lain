import assert from 'node:assert/strict';
import test from 'node:test';
import { refreshBridge } from './live.ts';

test('an in-flight REST poll cannot replace demo or a newer live generation', async () => {
  const oldLive = new AbortController();
  const pending = Promise.withResolvers();
  const states = [];
  const poll = refreshBridge(() => pending.promise, oldLive.signal, snapshot => states.push(snapshot));
  oldLive.abort();
  states.push('demo');
  const newLive = new AbortController();
  await refreshBridge(async path => path, newLive.signal, snapshot => states.push(snapshot));
  pending.resolve('stale REST result');
  await poll;
  assert.deepEqual(states, ['demo', {
    status: '/api/v1/status', memory: '/api/v1/memory', plugins: '/api/v1/plugins',
  }]);
});

test('failed or aborted polls never publish partial state', async () => {
  let published = false;
  const scope = new AbortController();
  await assert.rejects(refreshBridge(async () => { throw new Error('offline'); }, scope.signal,
    () => { published = true; }), /offline/);
  assert.equal(published, false);
  scope.abort();
  await refreshBridge(async () => { throw new Error('aborted'); }, scope.signal,
    () => { published = true; });
  assert.equal(published, false);
});
