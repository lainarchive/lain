/**
 * @generated
 * @purpose  M-3 model registry: one entry per invokable model, classed for the approval gate
 * @requires Chief-of-Staff
 */
import { listApprovals } from './approvalLedger.mjs';

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

/**
 * One approval record as both ledgers store it. The in-memory ledger (M-5)
 * and the persistent one (M-6) share the field names, so one reader serves
 * both. `outcome` is typed `string` because that is what the ledger typedefs
 * promise; both ledgers validate it against `OUTCOMES` at write time, and
 * the callers narrow it where they feed the engine's union.
 *
 * @typedef {{ decision_id: string, taskId: string, modelId: string, outcome: string, at?: string, decided_by?: string }} LedgerEntryLike
 */

/**
 * @typedef {{ list: () => LedgerEntryLike[] }} LedgerLike
 */

/**
 * Resolve a ledger decision for one invocation. M-8: this is the seam that
 * lets a recorded human approval do more than feed the engine's approval
 * status — when the entry is `granted` AND bound to the task asking, the
 * caller may treat the approval as the task's `model.invoke.external` grant.
 *
 * The binding is the load-bearing half of that rule. An approval recorded for
 * task X must never hand its capability to task Y, and a task file that
 * carries no id cannot prove it is the task the approver saw, so it is never
 * augmented — which is exactly the M-7 invariant (an approval does not
 * substitute for the capability) surviving M-8 rather than being rewritten.
 * The outcome itself still feeds the engine unbound, as M-7 shipped: a denied
 * entry denies whoever presents its decision id, because presenting someone
 * else's denied decision id is its own finding.
 *
 * The lookup is synchronous on purpose: both ledgers answer from memory or a
 * local SQLite file, and the callers decide inside one turn.
 *
 * @param {string | undefined} decisionId
 * @param {{ ledger?: LedgerLike, taskId?: string }} [options]
 *   `ledger` defaults to the in-memory module ledger, so tests need no file;
 *   production callers pass the persistent ledger's `{ list }`.
 * @returns {{ approved: boolean, entry: LedgerEntryLike | null }}
 *   `entry` is the raw record when the id is known (any outcome), null
 *   otherwise; `approved` is true only for a `granted` entry bound to
 *   `taskId`.
 */
export function resolveLedgerApproval(decisionId, options = {}) {
  if (typeof decisionId !== 'string' || decisionId === '') {
    return { approved: false, entry: null };
  }
  const ledger = options.ledger ?? { list: listApprovals };
  const entry = ledger.list().find((candidate) => candidate.decision_id === decisionId) ?? null;
  const approved =
    entry !== null &&
    entry.outcome === 'granted' &&
    options.taskId !== undefined &&
    entry.taskId === options.taskId;
  return { approved, entry };
}
