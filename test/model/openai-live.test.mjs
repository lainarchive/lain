// The OpenAI live transport's request shape and response mapping, pinned against an injected fetch — no network
import test from 'node:test';
import assert from 'node:assert/strict';
import { OPENAI_URL, OPENAI_MODEL, queryLive } from '../../src/model/provider/openai.mjs';
import { getCredentials } from '../../src/model/provider/credentials.mjs';

/**
 * The live transport is the only code in the repo that talks to api.openai.com.
 * These tests pin the request it must send and the mapping it must return,
 * using an injected fetch so the suite never leaves the machine. The one test
 * that does leave the machine is gated twice: ALLOW_LIVE=1 (the owner's
 * explicit switch) and OPENAI_FUNDED=1 (OpenAI has no free API tier).
 */

test('AT-M7-17: the live transport posts the ChatCompletion shape with the key only in the header', async () => {
  /** @type {Array<{ url: string, init: RequestInit }>} */
  const calls = [];
  const fetchImpl = /** @type {typeof fetch} */ (async (url, init) => {
    calls.push({ url: /** @type {string} */ (url), init: /** @type {RequestInit} */ (init) });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'mock-live-answer' } }] }), { status: 200 });
  });
  const result = await queryLive('hello', { apiKey: 'sk-test-abcdef123456', fetchImpl });
  assert.equal(calls.length, 1, 'exactly one request per invocation');
  assert.equal(calls[0].url, OPENAI_URL);
  assert.equal(calls[0].init.method, 'POST');
  const headers = /** @type {Record<string, string>} */ (calls[0].init.headers);
  assert.equal(headers.authorization, 'Bearer sk-test-abcdef123456');
  assert.ok(!calls[0].url.includes('sk-test'), 'the key must never travel in a URL');
  const body = /** @type {{ model: string, messages: Array<{ role: string, content: string }>, max_tokens: number }} */ (
    JSON.parse(/** @type {string} */ (calls[0].init.body))
  );
  assert.equal(body.model, OPENAI_MODEL);
  assert.deepEqual(body.messages, [{ role: 'user', content: 'hello' }]);
  assert.equal(body.max_tokens, 256);
  assert.deepEqual({ provider: result.provider, answer: result.answer, echo: result.echo, model: result.model }, {
    provider: 'openai',
    answer: 'mock-live-answer',
    echo: 'hello',
    model: OPENAI_MODEL,
  });
});

test('AT-M7-18: an HTTP error is a thrown failure that never quotes the key', async () => {
  const fetchImpl = /** @type {typeof fetch} */ (async () => new Response('{"error":"bad key"}', { status: 401 }));
  await assert.rejects(
    () => queryLive('hello', { apiKey: 'sk-secret-value', fetchImpl }),
    (err) => {
      assert.match(/** @type {Error} */ (err).message, /HTTP 401/);
      assert.ok(!/** @type {Error} */ (err).message.includes('sk-secret-value'), 'the key must never appear in an error');
      return true;
    },
  );
});

test('AT-M7-19: a missing or empty key is refused before any request', async () => {
  let calls = 0;
  const fetchImpl = /** @type {typeof fetch} */ (async () => {
    calls += 1;
    return new Response('{}', { status: 200 });
  });
  await assert.rejects(() => queryLive('hello', { apiKey: '', fetchImpl }), /requires an api key/);
  await assert.rejects(() => queryLive('hello', { fetchImpl }), /requires an api key/);
  assert.equal(calls, 0, 'no request may be attempted without a key');
});

test('AT-M7-20: an unexpected response shape is a thrown failure, not an empty answer', async () => {
  const fetchImpl = /** @type {typeof fetch} */ (async () => new Response('{"unexpected":true}', { status: 200 }));
  await assert.rejects(() => queryLive('hello', { apiKey: 'sk-test', fetchImpl }), /unexpected response shape/);
});

test('AT-M7-21: a real free-tier call — double-gated, skipped by default', { skip: !(process.env.ALLOW_LIVE === '1' && process.env.OPENAI_FUNDED === '1') }, async () => {
  const credentials = getCredentials('openai');
  assert.notEqual(credentials.apiKey, null, 'ALLOW_LIVE=1 and OPENAI_FUNDED=1 need a real credential');
  const result = await queryLive('reply with the single word: pong', { apiKey: /** @type {string} */ (credentials.apiKey) });
  assert.equal(result.provider, 'openai');
  assert.equal(typeof result.answer, 'string');
  assert.ok(result.answer.length > 0, 'the provider must return a non-empty answer');
});
