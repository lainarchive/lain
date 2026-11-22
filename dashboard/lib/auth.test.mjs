import assert from 'node:assert/strict';
import test from 'node:test';
import { captureToken, authorizedHeaders, websocketProtocols } from './auth.ts';

test('launch token survives hash removal and a page reload', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  let stripped = false;
  assert.equal(captureToken('#token=launch-token', storage, () => { stripped = true; }), 'launch-token');
  assert.equal(stripped, true);
  assert.equal(captureToken('', storage, () => assert.fail('no hash to strip')), 'launch-token');
  assert.equal(captureToken('#token=next-launch', storage, () => {}), 'next-launch');
  assert.equal(captureToken('', { getItem: () => null, setItem: () => {} }, () => {}), '');
});

test('REST and WebSocket carry the token without putting it in the URL', () => {
  const headers = authorizedHeaders('launch-token', { 'Content-Type': 'application/json' });
  assert.equal(headers.get('Authorization'), 'Bearer launch-token');
  assert.equal(headers.get('Content-Type'), 'application/json');
  assert.deepEqual(websocketProtocols('launch-token'), ['lain-dashboard', 'lain-token.launch-token']);
});

test('blocked storage still permits the launch token', () => {
  const storage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  let stripped = false;
  assert.equal(captureToken('#token=launch-token', storage, () => { stripped = true; }), 'launch-token');
  assert.equal(stripped, true);
});
