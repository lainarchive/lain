/**
 * @generated
 * @purpose  M-3 model registry: one entry per invokable model, classed for the approval gate
 * @requires Chief-of-Staff
 */

/**
 * @typedef {{ id: string, provider: string, name: string, cost: number, effect_class: string }} ModelDescriptor
 */

/**
 * The registry is the single place a model's invocation channel is declared.
 * `effect_class` describes the channel's worst case, not the model's intent:
 * a real provider reaches the network, so it is `external` and the policy
 * engine lands it in A5 where a human decides. The mock is marked `external`
 * too — deliberately. Fail-closed is the rule: until a channel is proven
 * local, the restrictive class is the honest one, and a gate that no entry
 * can trigger is decoration, not defense. Proving the mock's channel local
 * (and reclassing it) is M-4 work, with evidence.
 *
 * @type {Record<string, ModelDescriptor>}
 */
export const MODEL_REGISTRY = Object.freeze({
  'local-mock': Object.freeze({
    id: 'local-mock',
    provider: 'local',
    name: 'mock-model',
    cost: 0,
    effect_class: 'external',
  }),
});

/**
 * Look up one model by id. Unknown ids return undefined; the caller decides
 * what an unknown model means — for the approval gate it is a caller error,
 * not an approval need.
 *
 * @param {string} id
 * @returns {{ id: string, provider: string, name: string, cost: number, effect_class: string } | undefined}
 */
export function getModel(id) {
  return MODEL_REGISTRY[id];
}
