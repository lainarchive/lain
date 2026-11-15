/**
 * @generated
 * @purpose  M-5 OpenAI provider stub: the shape of a real adapter, with no network behind it
 * @requires Chief-of-Staff
 */
/**
 * Fixed mock response. The stub exists to pin the adapter contract — one
 * function, prompt in, structured answer out — before any real channel is
 * considered. It reaches nothing: no fetch, no API key, no network. When a
 * real adapter replaces this file it lands in the registry as `external`
 * and stays there until its channel is proven and the human gate approves
 * it; a stub that silently became a live external call is the failure mode
 * this file is built to make visible.
 *
 * @param {string} prompt
 * @returns {{ provider: 'openai', answer: string, echo: string }}
 */
export function query(prompt) {
  return { provider: 'openai', answer: 'mock-openai-response', echo: prompt };
}
