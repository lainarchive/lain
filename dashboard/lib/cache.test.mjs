import assert from 'node:assert/strict';
import test from 'node:test';
import { createBridgeCache, applyBridgeEvent } from './cache.ts';

test('resources have stable empty snapshots and notify only their subscribers', () => {
  const cache = createBridgeCache();
  const initial = cache.get('/api/v1/status');
  assert.equal(cache.get('/api/v1/status'), initial);
  assert.deepEqual(initial.sessions, []);
  let statusUpdates = 0;
  let memoryUpdates = 0;
  const unsubscribe = cache.subscribe('/api/v1/status', () => statusUpdates++);
  cache.subscribe('/api/v1/memory', () => memoryUpdates++);
  cache.set('/api/v1/status', initial);
  assert.equal(statusUpdates, 0);
  cache.set('/api/v1/status', { ...initial, latest_sequence: 10 });
  assert.equal(statusUpdates, 1);
  assert.equal(memoryUpdates, 0);
  unsubscribe();
  cache.set('/api/v1/status', initial);
  assert.equal(statusUpdates, 1);
  assert.deepEqual(createBridgeCache().get('/api/v1/status'), initial);
});

test('Core events update cached trace and matching session resources without duplicates', () => {
  const cache = createBridgeCache();
  cache.set('/api/v1/status', { ...cache.get('/api/v1/status'), sessions: [{ session_id: 's', status: 'idle', control: { pending_call: null } }] });
  const frame = { sequence: 1, session_id: 's', timestamp_ms: 100, event: { type: 'intent_received', text: 'inspect' } };
  applyBridgeEvent(cache, frame);
  const trace = cache.get('/ws/events');
  assert.equal(trace.graph.nodes[0].input, 'inspect');
  assert.equal(cache.get('/api/v1/status').sessions[0].status, 'running');
  assert.equal(cache.get('/api/v1/status').latest_sequence, 1);
  applyBridgeEvent(cache, frame);
  assert.equal(cache.get('/ws/events'), trace);
  applyBridgeEvent(cache, { ...frame, sequence: 2, event: { type: 'approval_required', call_id: 'call', name: 'Bash', turn: 1, arguments: {} } });
  assert.equal(cache.get('/api/v1/status').sessions[0].control.pending_call, 'call');
});

test('a failed query leaves the last resource snapshot intact', async () => {
  const cache = createBridgeCache();
  const initial = cache.get('/api/v1/memory');
  await assert.rejects(async () => {
    const load = async () => { throw new Error('offline'); };
    cache.set('/api/v1/memory', await load());
  }, /offline/);
  assert.equal(cache.get('/api/v1/memory'), initial);
});
