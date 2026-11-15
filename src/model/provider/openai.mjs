/**
 * @generated
 * @purpose  M-5 OpenAI provider stub + M-7 live transport: the stub pins the adapter contract, queryLive is the real channel
 * @requires Chief-of-Staff
 */
/**
 * Fixed mock response. The stub exists to pin the adapter contract — one
 * function, prompt in, structured answer out — before any real channel is
 * considered. It reaches nothing: no fetch, no API key, no network. The live
 * transport below shares this file so the contract and its realisation cannot
 * drift apart; the stub itself is unchanged from M-5.
 *
 * @param {string} prompt
 * @returns {{ provider: 'openai', answer: string, echo: string }}
 */
export function query(prompt) {
  return { provider: 'openai', answer: 'mock-openai-response', echo: prompt };
}

/** The ChatCompletion endpoint. Kept as a constant so a test can assert the request without network. */
export const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

/** The cheapest widely-available model — $0-first means the smallest bill, and this module is blocked on funding anyway. */
export const OPENAI_MODEL = 'gpt-4o-mini';

/**
 * One live ChatCompletion call. The caller must already hold a policy decision
 * that permits an external invocation (A5b) — this function is the transport,
 * not the gate, and it checks nothing but its own arguments.
 *
 * `fetchImpl` is injectable so tests can pin the request shape and the
 * response mapping without network; production passes nothing and gets the
 * platform fetch. The key travels only in the Authorization header, never in
 * a URL, and is never included in an error message.
 *
 * @param {string} prompt
 * @param {{ apiKey: string, fetchImpl?: typeof fetch, model?: string, timeoutMs?: number }} options
 * @returns {Promise<{ provider: 'openai', answer: string, echo: string, model: string }>}
 */
export async function queryLive(prompt, options) {
  const { apiKey, fetchImpl = fetch, model = OPENAI_MODEL, timeoutMs = 30_000 } = options ?? {};
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    throw new Error('the openai live transport requires an api key (AGY_ACCOUNT or the repo .env file)');
  }
  const response = await fetchImpl(OPENAI_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 256 }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`openai chat completion failed: HTTP ${response.status}`);
  }
  const body = /** @type {{ choices?: Array<{ message?: { content?: string } }> }} */ (await response.json());
  const answer = body.choices?.[0]?.message?.content;
  if (typeof answer !== 'string') {
    // An absent answer is a shape violation, not an empty one — a silent ''
    // would look like success downstream.
    throw new Error('openai chat completion returned an unexpected response shape');
  }
  return { provider: 'openai', answer, echo: prompt, model };
}
