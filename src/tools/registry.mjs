/**
 * The tool registry.
 *
 * Only tools listed in the rule set may be invoked at all. A tool that exists as
 * code but is absent from the rules is *not* selectable — that ordering is
 * deliberate, because the alternative (code first, rules later) is how a tool
 * becomes callable by accident.
 */
import { PolicyConfigError, toolRule } from '../policy/rules.mjs';

/**
 * @typedef {object} RunContext
 * @property {import('../core/types.mjs').WorkspaceHandle} workspace
 * @property {string[]} capabilities
 * @property {string[]} conditions
 * @property {{remaining_tool_calls: number, max_output_bytes: number, max_wall_ms: number}} budget
 * @property {import('../core/types.mjs').PolicyDecision} decision
 *
 * @typedef {object} ToolDefinition
 * @property {string} tool_id
 * @property {string} summary
 * @property {string[]} requires            capabilities the task must hold
 * @property {string} effect_class          must match the rule set, or the tool is refused
 * @property {boolean} spawns_processes
 * @property {(args: Record<string, unknown>, ctx: RunContext) => Record<string, unknown>|Promise<Record<string, unknown>>} run
 */

/**
 * @param {{rules: import('../policy/rules.mjs').RuleSet}} options
 * @returns {import('../core/types.mjs').Registry}
 */
export function createRegistry({ rules }) {
  /** @type {Map<string, ToolDefinition>} */
  const tools = new Map();

  return {
    /**
     * Register a tool. Registration is refused when the rule set does not list
     * the tool, when the declared effect class disagrees with the rule, or when
     * the tool needs capabilities the rule does not require — three ways a tool
     * could otherwise acquire authority the rules never granted.
     *
     * @param {ToolDefinition} definition
     */
    register(definition) {
      const rule = toolRule(rules, definition.tool_id);
      if (!rule) {
        throw new PolicyConfigError(`tool "${definition.tool_id}" is not listed in the rule set`, {
          tool_id: definition.tool_id,
        });
      }
      if (rule.tool_effect_class !== definition.effect_class) {
        throw new PolicyConfigError(`tool "${definition.tool_id}" declares effect class "${definition.effect_class}" but the rule set says "${rule.tool_effect_class}"`, {
          tool_id: definition.tool_id,
          declared: definition.effect_class,
          ruled: rule.tool_effect_class,
          why: 'a tool must not be able to describe itself as less dangerous than the policy allows',
        });
      }
      const missing = rule.requires.filter((cap) => !definition.requires.includes(cap));
      if (missing.length > 0) {
        throw new PolicyConfigError(`tool "${definition.tool_id}" does not require ${missing.join(', ')}`, {
          tool_id: definition.tool_id,
          missing,
          why: 'a tool may not hold more authority than the rule set grants it',
        });
      }
      tools.set(definition.tool_id, definition);
      return definition;
    },

    /** @param {string} toolId */
    get(toolId) {
      return tools.get(toolId) ?? null;
    },

    list() {
      return [...tools.values()].map((t) => ({
        tool_id: t.tool_id,
        summary: t.summary,
        effect_class: t.effect_class,
        requires: [...t.requires],
        spawns_processes: t.spawns_processes,
      }));
    },

    /** Capability names the rule set lists for a tool. @param {string} toolId */
    requiredCapabilities(toolId) {
      return toolRule(rules, toolId)?.requires ?? [];
    },
  };
}
