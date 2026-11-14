/**
 * @generated
 * @purpose  Model selection stub for M-2: one local mock, zero cost
 * @requires Chief-of-Staff
 */

/**
 * Round-robin selection collapses to a single entry while the registry holds
 * one model. The descriptor shape is the contract M-3 extends with real
 * providers; `cost: 0` is the $0-first policy made visible rather than assumed.
 *
 * @param {{ id: string }} _task the task, unused while selection is static
 * @returns {{ provider: string, name: string, cost: number }}
 */
export function selectModel(_task) {
  return { provider: 'local', name: 'mock-model', cost: 0 };
}
