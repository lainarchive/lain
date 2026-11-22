// The Gemini live transport's request shape and response mapping, pinned against an injected fetch — no network
import test from 'node:test';
import assert from 'node:assert/strict';
import { GEMINI_MODEL, queryLive } from '../../src/model/provider/gemini.mjs';
import { getCredentials } from '../../src/model/provider/credentials.mjs';

/**
 * Gemini is the one provider with a genuine free tier, so its live test is
 * gated once: ALLOW_LIVE=1. The mocked tests pin the request shape — the key
 * in the x-goog-api-key header, never in the URL — and the response mapping.
 */

test('AT-M7-22: the live transport posts generateContent with the key only in its header', async () => {
  /** @type {Array<{ url: string, init: RequestInit }>} */
  const calls = [];
  const fetchImpl = /** @type {typeof fetch} */ (async (url, init) => {
    calls.push({ url: /** @type {string} */ (url), init: /** @type {RequestInit} */ (init) });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'mock-live-answer' }] } }] }), { status: 200 });
  });
  const result = await queryLive('hello', { apiKey: 'ai-test-abcdef123456', fetchImpl });
  assert.equal(calls.length, 1, 'exactly one request per invocation');
  assert.ok(calls[0].url.includes(`models/${GEMINI_MODEL}:generateContent`), 'the endpoint names the free-tier model');
  assert.ok(!calls[0].url.includes('ai-test'), 'the key must never travel in a URL');
  const headers = /** @type {Record<string, string>} */ (calls[0].init.headers);
  assert.equal(headers['x-goog-api-key'], 'ai-test-abcdef123456');
  const body = /** @type {{ contents: Array<{ parts: Array<{ text: string }> }> }} */ (
    JSON.parse(/** @type {string} */ (calls[0].init.body))
  );
  assert.deepEqual(body.contents, [{ parts: [{ text: 'hello' }] }]);
  assert.deepEqual({ provider: result.provider, answer: result.answer, echo: result.echo, model: result.model }, {
    provider: 'gemini',
    answer: 'mock-live-answer',
    echo: 'hello',
    model: GEMINI_MODEL,
  });
});

test('AT-M7-23: an HTTP error is a thrown failure that never quotes the key', async () => {
  const fetchImpl = /** @type {typeof fetch} */ (async () => new Response('{"error":"bad key"}', { status: 403 }));
  await assert.rejects(
    () => queryLive('hello', { apiKey: 'ai-secret-value', fetchImpl }),
    (err) => {
      assert.match(/** @type {Error} */ (err).message, /HTTP 403/);
      assert.ok(!/** @type {Error} */ (err).message.includes('ai-secret-value'), 'the key must never appear in an error');
      return true;
    },
  );
});

test('AT-M7-24: a missing or empty key is refused before any request', async () => {
  let calls = 0;
  const fetchImpl = /** @type {typeof fetch} */ (async () => {
    calls += 1;
    return new Response('{}', { status: 200 });
  });
  await assert.rejects(() => queryLive('hello', { apiKey: '', fetchImpl }), /requires an api key/);
  await assert.rejects(() => queryLive('hello', { fetchImpl }), /requires an api key/);
  assert.equal(calls, 0, 'no request may be attempted without a key');
});

test('AT-M7-25: an unexpected response shape is a thrown failure, not an empty answer', async () => {
  const fetchImpl = /** @type {typeof fetch} */ (async () => new Response('{"unexpected":true}', { status: 200 }));
  await assert.rejects(() => queryLive('hello', { apiKey: 'ai-test', fetchImpl }), /unexpected response shape/);
});

test('AT-M7-26: a real free-tier call — gated on ALLOW_LIVE=1, skipped by default', { skip: process.env.ALLOW_LIVE !== '1' }, async () => {
  const credentials = getCredentials('gemini');
  assert.notEqual(credentials.apiKey, null, 'ALLOW_LIVE=1 needs a real credential');
  const result = await queryLive('reply with the single word: pong', { apiKey: /** @type {string} */ (credentials.apiKey) });
  assert.equal(result.provider, 'gemini');
  assert.equal(typeof result.answer, 'string');
  assert.ok(result.answer.length > 0, 'the provider must return a non-empty answer');
});
