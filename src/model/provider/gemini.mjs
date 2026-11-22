// Gemini provider stub + M-7 live transport: the stub pins the adapter contract, queryLive is the real free-tier channel
/**
 * Fixed mock response — same contract as the OpenAI stub, different marker,
 * so a test can tell the two adapters apart. Reaches nothing: no fetch, no
 * API key, no network. The live transport below shares this file so the
 * contract and its realisation cannot drift apart; the stub itself is
 * unchanged from M-5.
 *
 * @param {string} prompt
 * @returns {{ provider: 'gemini', answer: string, echo: string }}
 */
export function query(prompt) {
  return { provider: 'gemini', answer: 'mock-gemini-response', echo: prompt };
}

/** The generateContent endpoint for the free-tier model (AI Studio key, no billing attached). */
export const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent';

/** The free-tier model. The plan named the Gemini 1.5 API; flash is its $0 quota tier. */
export const GEMINI_MODEL = 'gemini-1.5-flash';

/**
 * One live generateContent call against the Gemini free tier. The caller must
 * already hold a policy decision that permits an external invocation (A5b) —
 * this function is the transport, not the gate.
 *
 * The key travels in the `x-goog-api-key` header, never in the URL (a URL
 * ends up in logs and histories; a header does not), and is never included in
 * an error message. `fetchImpl` is injectable for tests.
 *
 * @param {string} prompt
 * @param {{ apiKey: string, fetchImpl?: typeof fetch, model?: string, timeoutMs?: number }} options
 * @returns {Promise<{ provider: 'gemini', answer: string, echo: string, model: string }>}
 */
export async function queryLive(prompt, options) {
  const { apiKey, fetchImpl = fetch, model = GEMINI_MODEL, timeoutMs = 30_000 } = options ?? {};
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    throw new Error('the gemini live transport requires an api key (AGY_ACCOUNT or the repo .env file)');
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`gemini generateContent failed: HTTP ${response.status}`);
  }
  const body = /** @type {{ candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }} */ (await response.json());
  const parts = body.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) {
    // An absent candidate is a shape violation, not an empty answer — a
    // silent '' would look like success downstream.
    throw new Error('gemini generateContent returned an unexpected response shape');
  }
  const answer = parts.map((part) => part.text ?? '').join('');
  return { provider: 'gemini', answer, echo: prompt, model };
}
