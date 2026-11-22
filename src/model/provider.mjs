// Provider loader: resolve a registered model to its invocation function
import { getModel } from './registry.mjs';

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
