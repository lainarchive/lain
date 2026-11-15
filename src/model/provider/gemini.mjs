/**
 * @generated
 * @purpose  M-5 Gemini provider stub: the shape of a real adapter, with no network behind it
 * @requires Chief-of-Staff
 */
/**
 * Fixed mock response — same contract as the OpenAI stub, different marker,
 * so a test can tell the two adapters apart. Reaches nothing: no fetch, no
 * API key, no network. A real adapter replaces this file under the same
 * rule: registry entry `external`, human gate, proven channel first.
 *
 * @param {string} prompt
 * @returns {{ provider: 'gemini', answer: string, echo: string }}
 */
export function query(prompt) {
  return { provider: 'gemini', answer: 'mock-gemini-response', echo: prompt };
}
