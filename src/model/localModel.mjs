/**
 * @generated
 * @purpose  Zero-cost mock model for M-2
 * @requires Chief-of-Staff
 */

/**
 * The mock stands in for a provider until M-3. It answers with a constant and
 * echoes the prompt, so a test can prove what reached it — and that nothing
 * else did. No network, no dependency, no cost.
 *
 * @param {string} prompt
 * @returns {{ answer: string, echo: string }}
 */
export function localModel(prompt) {
  return { answer: 'mock-response', echo: prompt };
}
