/**
 * @generated
 * @purpose  M-4 provider loader: resolve a registered model to its invocation function
 * @requires Chief-of-Staff
 */
import { getModel } from './registry.mjs';

/** Thrown when a model's provider cannot be resolved — unknown id or unknown kind. */
export class ProviderNotFound extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'ProviderNotFound';
    this.code = 'PROVIDER_NOT_FOUND';
  }
}

/**
 * One loader per provider kind. `local` is a static specifier today; a future
 * remote kind adds its own loader here and stays behind the same seam — the
 * caller never learns how the module arrived, only that it exports an invoke
 * function. Loading is lazy: nothing is imported until a model is actually
 * resolved, so a registry entry costs nothing until it is used.
 *
 * @type {Record<string, () => Promise<{ localModel: (prompt: string) => { answer: string, echo: string } }>>}
 */
const PROVIDER_LOADERS = {
  local: () => import('./localModel.mjs'),
};

/**
 * Resolve a registered model to its invocation function. Resolution is not
 * authorization: the approval gate still decides whether the invocation may
 * run, and the loader deliberately knows nothing about capabilities.
 *
 * @param {string} modelId
 * @param {{ registry?: Record<string, { id: string, provider: string, name: string, cost: number, effect_class: string }> }} [options]
 * @returns {Promise<(prompt: string) => { answer: string, echo: string }>}
 */
export async function loadProvider(modelId, options = {}) {
  const descriptor = options.registry ? options.registry[modelId] : getModel(modelId);
  if (!descriptor) throw new ProviderNotFound(`no registered model: ${modelId}`);
  const loader = PROVIDER_LOADERS[descriptor.provider];
  if (!loader) throw new ProviderNotFound(`no provider loader for kind: ${descriptor.provider}`);
  const module = await loader();
  return module.localModel;
}
