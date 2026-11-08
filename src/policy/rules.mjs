/**
 * The default rule set.
 *
 * This file is what a policy *is* in the first milestone: a small, explicit,
 * reviewable list of what may be invoked, which capabilities a tool needs, and
 * which paths are off limits. It is data because a rule that lives in code is a
 * rule nobody reviews.
 *
 * It is deliberately not a general rule language. Anything more expressive would
 * need its own evaluation semantics, its own tests and its own failure modes —
 * and the point of the first milestone is a policy that can be read in full on
 * one screen.
 */

/**
 * @typedef {object} RuleSet
 * @property {number} version
 * @property {string} note
 * @property {Record<string, {tool_effect_class: string, requires: string[]}>} tools
 * @property {string[]} forbidden_paths
 * @property {string[]} always_requires_approval
 */

/** @type {RuleSet} */
export const DEFAULT_RULES = Object.freeze({
  version: 1,
  note:
    'Default rule set for the first execurable milestone. Only tools listed here may be invoked at all; ' +
    'anything absent is refused by the default arm rather than by a missing check.',
  tools: {
    'run_script': { tool_effect_class: 'local_reversible', requires: ['workspace.write', 'process.spawn'] },
    'read_file': { tool_effect_class: 'read_only', requires: ['workspace.read'] },
    'write_file': { tool_effect_class: 'local_reversible', requires: ['workspace.write'] },
  },
  forbidden_paths: [
    '.lain-audit',
    '.git',
    '.ssh',
    '.aws',
    '.config',
    'AppData\\Roaming',
    'AppData\\Local\\Google',
    'AppData\\Local\\Microsoft\\Credentials',
  ],
  always_requires_approval: ['local_irreversible', 'external'],
});

/**
 * Load a rule set, validating its shape. A malformed rule set is an error, not a
 * set of defaults: silently falling back would mean running with rules nobody
 * wrote.
 *
 * @param {unknown} raw
 * @returns {RuleSet}
 */
export function validateRuleSet(raw) {
  if (!raw || typeof raw !== 'object') throw new PolicyConfigError('rule set must be an object');
  const rules = /** @type {Record<string, unknown>} */ (raw);
  if (!Number.isInteger(rules.version)) throw new PolicyConfigError('rule set needs an integer version');
  if (!rules.tools || typeof rules.tools !== 'object') throw new PolicyConfigError('rule set needs a tools map');
  if (!Array.isArray(rules.forbidden_paths)) throw new PolicyConfigError('rule set needs forbidden_paths');
  if (!Array.isArray(rules.always_requires_approval)) throw new PolicyConfigError('rule set needs always_requires_approval');
  return /** @type {RuleSet} */ (raw);
}

export class PolicyConfigError extends Error {
  /**
   * @param {string} message
   * @param {object} [detail]
   */
  constructor(message, detail = {}) {
    super(message);
    this.name = 'PolicyConfigError';
    this.code = 'POLICY_CONFIG';
    this.detail = detail;
  }
}

/**
 * @param {RuleSet} rules
 * @param {string} toolId
 */
export function toolRule(rules, toolId) {
  return Object.prototype.hasOwnProperty.call(rules.tools, toolId) ? rules.tools[toolId] : null;
}

/**
 * Build the policy context for one request: what the rule set says, plus what
 * the task was granted.
 *
 * @param {object} args
 * @param {RuleSet} args.rules
 * @param {string} args.tool_id
 * @param {string[]} args.granted_capabilities
 * @param {{exceeded: boolean, detail?: string}} [args.budget]
 * @param {{status: 'pending'|'granted'|'denied'|'timed_out'|null, approval_id?: string}} [args.approval]
 * @param {boolean} [args.complete]
 */
export function buildContext({ rules, tool_id, granted_capabilities, budget, approval, complete }) {
  const rule = toolRule(rules, tool_id);
  const required = rule?.requires ?? [];
  const granted = rule !== null && required.every((cap) => granted_capabilities.includes(cap));
  return {
    granted,
    forbidden: rule === null,
    budget,
    approval: approval ?? { status: null },
    complete: complete ?? rule !== null,
  };
}
