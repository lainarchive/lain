/**
 * Task runner.
 *
 * The whole flow for one task, in the order the design requires: record, then
 * decide, then act. There is no agent loop here — the task names one tool and
 * the runner runs it — and that is deliberate: the loop is what M-2 adds, and it
 * will call *this* rather than replace it.
 *
 * Two properties worth stating because the code exists to enforce them:
 *
 *   1. **Nothing runs without a recorded decision.** The admission decision and
 *      the tool decision are both written to the event log before the effect.
 *   2. **`completed` is unreachable by assertion.** The only path to it is every
 *      required criterion passing against artifacts that actually exist.
 */
import { LainError } from '../core/errors.mjs';
import { join } from 'node:path';
import { decide } from '../policy/decide.mjs';
import { buildContext } from '../policy/rules.mjs';
import { toolRule } from '../policy/rules.mjs';
import { createWorkspace } from '../exec/workspace.mjs';
import { createInvoker } from '../tools/invoke.mjs';
import '../core/types.mjs';

export class RunnerError extends LainError {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [detail]
   */
  constructor(code, message, detail = {}) {
    super(code, message, detail);
    this.name = 'RunnerError';
  }
}

/**
 * Evaluate acceptance criteria against what actually exists.
 *
 * Every criterion gets exactly one of three verdicts: `passed`, `failed`, or
 * `not_evaluated` with a reason. **A criterion that cannot be evaluated is never
 * counted as passed** — that rule is why this function exists.
 *
 * @param {import('../core/types.mjs').Criterion[]} criteria
 * @param {{toolResult: Record<string, unknown>|null}} ctx
 * @returns {import('../core/types.mjs').CriterionResult[]}
 */
export function evaluateCriteria(criteria, ctx) {
  /** @type {import('../core/types.mjs').CriterionResult[]} */
  const checks = [];
  const artifacts = /** @type {{path: string, bytes: number}[]} */ (ctx.toolResult?.artifacts ?? []);
  const present = new Map(artifacts.map((a) => [a.path, a.bytes]));

  for (const criterion of criteria) {
    const base = { id: criterion.id, statement: criterion.statement, required: criterion.required };
    const kind = criterion.check?.kind;

    if (kind === 'artifact') {
      const path = String(criterion.check.path ?? '');
      if (path.length === 0) {
        checks.push({ ...base, verdict: 'not_evaluated', detail: 'the criterion declares no artifact path' });
      } else if (present.has(path)) {
        checks.push({ ...base, verdict: 'passed', detail: `artifact present: ${path} (${present.get(path)} B)` });
      } else {
        checks.push({ ...base, verdict: 'failed', detail: `artifact absent: ${path}` });
      }
      continue;
    }

    if (kind === 'assertion') {
      const expected = criterion.check.exit_code;
      if (typeof expected !== 'number') {
        checks.push({ ...base, verdict: 'not_evaluated', detail: 'the assertion declares no exit_code' });
      } else if (ctx.toolResult?.exit_code === expected) {
        checks.push({ ...base, verdict: 'passed', detail: `exit_code ${expected} observed` });
      } else {
        checks.push({ ...base, verdict: 'failed', detail: `exit_code ${expected} expected, ${ctx.toolResult?.exit_code ?? 'none'} observed` });
      }
      continue;
    }

    if (kind === 'command') {
      // Declared shell text is NOT executed: a second execution path outside the
      // tool boundary would bypass the environment allow-list, the timeout and
      // the scrub. It is reported as not evaluated rather than quietly passed.
      checks.push({
        ...base,
        verdict: 'not_evaluated',
        detail: 'command criteria are not executed in this milestone; use a script plus an artifact criterion',
      });
      continue;
    }

    checks.push({ ...base, verdict: 'not_evaluated', detail: `unknown criterion kind "${kind}"` });
  }
  return checks;
}

/**
 * @param {object} args
 * @param {import('../core/types.mjs').TaskStore} args.taskStore
 * @param {(info: {task_id: string}) => import('../core/types.mjs').EventLog} args.openLog
 * @param {import('../core/types.mjs').Registry} args.registry
 * @param {import('../policy/rules.mjs').RuleSet} args.rules
 * @param {string} args.workspaceRoot
 * @param {(workspace: import('../core/types.mjs').WorkspaceHandle) => import('../tools/registry.mjs').ToolDefinition} args.makeTool
 * @param {{allow?: string[]}} [args.approvals]
 * @param {() => number} [args.now]
 * @returns {{
 *   run: (args: {
 *     contract: import('../core/types.mjs').TaskContract,
 *     tool_id: string,
 *     tool_arguments: Record<string, unknown>,
 *     origin?: string,
 *   }) => Promise<import('../core/types.mjs').RunnerOutcome>,
 * }}
 */
export function createTaskRunner({
  taskStore,
  openLog,
  registry,
  rules,
  workspaceRoot,
  makeTool,
  approvals = {},
  now = Date.now,
}) {
  return {
    /**
     * @param {object} args
     * @param {import('../core/types.mjs').TaskContract} args.contract
     * @param {string} args.tool_id
     * @param {Record<string, unknown>} args.tool_arguments
     * @param {string} [args.origin]
     * @returns {Promise<import('../core/types.mjs').RunnerOutcome>}
     */
    async run({ contract, tool_id, tool_arguments, origin = 'cli' }) {
      const created = taskStore.create({ contract, origin });
      const taskId = created.task_id;
      const log = openLog({ task_id: taskId });
      const record = (/** @type {{event_type: string, payload?: Record<string, unknown>, correlation_id?: string, causation_id?: string}} */ event) =>
        log.record(event.event_type, event.payload ?? {}, { correlation_id: event.correlation_id, causation_id: event.causation_id });

      record({ event_type: 'task.created', payload: { objective: contract.objective, effect_class: contract.effect_class } });

      // -- admission: decided before a workspace or a tool exists --------------
      //
      // `granted` is the intersection of what the tool requires and what the task
      // declared — never simply what the tool requires. Passing the requirement
      // set in as though it had been granted makes the grant check true by
      // construction, which is how a task with `capabilities: []` ran a script:
      // the acceptance run caught it. `policySees` is that intersection plus
      // anything the task declared beyond the rule set, so the policy still gets
      // to judge the surplus (A6) while the requirement check stays honest.
      const required = registry.requiredCapabilities(tool_id);
      const declared = new Set(contract.capabilities);
      const grantedCaps = required.filter((cap) => declared.has(cap));
      const policySees = [...new Set([...grantedCaps, ...contract.capabilities])];

      const admission = decide(
        {
          action: 'task.admit',
          target: tool_id,
          task_id: taskId,
          requested_capabilities: contract.capabilities,
          effect_class: contract.effect_class,
          requested_by: origin,
        },
        buildContext({ rules, tool_id, granted_capabilities: policySees, budget: { exceeded: false }, approval: { status: null }, complete: true }),
      );

      if (admission.outcome !== 'allow' && admission.outcome !== 'allow_with_conditions') {
        taskStore.transition(taskId, 'failed', { reason: `admission refused: ${admission.reason_code}` });
        record({ event_type: 'task.failed', payload: { reason_code: admission.reason_code, decision_id: admission.decision_id } });
        return { task_id: taskId, state: 'failed', admission, invocation: null, result: null, workspace: null };
      }

      taskStore.transition(taskId, 'admitted', { reason: `admitted by ${admission.arm_id}` });
      record({ event_type: 'task.admitted', payload: { decision_id: admission.decision_id, arm_id: admission.arm_id } });

      // Capabilities are granted once, at admission, and only for the tools that
      // will actually run. Nothing after this line may add to the set.
      const granted = taskStore.grantCapabilities(taskId, grantedCaps, { granted_by: `policy:${admission.arm_id}` });

      // The tool decision is taken *before* anything is created on disk, so a
      // refusal costs nothing and leaves no artefact to clean up.
      /** @type {{status: 'granted'|'denied'|'pending'|'timed_out'|null, approval_id?: string}} */
      const toolApproval = approvals.allow?.includes(tool_id) ? { status: 'granted', approval_id: 'cli-allow' } : { status: null };
      const provisionalWorkspace = { path: join(workspaceRoot, taskId) };
      const toolDecision = decide(
        {
          action: `tool.${tool_id}`,
          target: provisionalWorkspace.path,
          task_id: taskId,
          requested_capabilities: granted,
          // The effect class comes from the rule set, not from the registry: the
          // registry has no tool until one is bound to a workspace, and the rule
          // set is the authority anyway. Reading a missing tool as "unknown,
          // therefore external" would make every unregistered tool look like the
          // most dangerous class — the right refusal, for the wrong reason.
          effect_class: registry.get(tool_id)?.effect_class ?? toolRule(rules, tool_id)?.tool_effect_class ?? 'external',
          requested_by: origin,
        },
        buildContext({ rules, tool_id, granted_capabilities: granted, budget: { exceeded: false }, approval: toolApproval, complete: true }),
      );

      if (toolDecision.outcome !== 'allow' && toolDecision.outcome !== 'allow_with_conditions') {
        taskStore.transition(taskId, 'failed', { reason: `tool refused: ${toolDecision.reason_code}` });
        record({
          event_type: 'task.failed',
          payload: { reason_code: toolDecision.reason_code, decision_id: toolDecision.decision_id, missing_capabilities: required.filter((cap) => !granted.includes(cap)) },
        });
        return { task_id: taskId, state: 'failed', admission, invocation: null, result: null, workspace: null };
      }

      // Only now is anything created on disk: the decision above is the last
      // gate, and a refusal must not leave a workspace to clean up.
      const workspace = createWorkspace({ root: workspaceRoot, task_id: taskId, forbidden: rules.forbidden_paths, now });
      workspace.create();
      record({ event_type: 'workspace.created', payload: { path: workspace.path } });

      taskStore.transition(taskId, 'running', { reason: 'executing one tool' });
      record({ event_type: 'task.running', payload: { tool_id } });

      registry.register(makeTool(workspace));

      const invoker = createInvoker({
        registry,
        record: (event) => log.record(event.event_type, event.payload ?? {}, { correlation_id: event.correlation_id, causation_id: event.causation_id }),
        workspace,
      });
      const invocation = await invoker.invoke({
        tool_id,
        arguments: tool_arguments,
        decision: toolDecision,
        task_id: taskId,
        capabilities: granted,
        budget: {
          remaining_tool_calls: contract.budget.max_tool_calls,
          max_output_bytes: contract.budget.max_output_bytes,
          max_wall_ms: contract.budget.max_wall_ms,
        },
      });
      /** @type {Record<string, unknown>|null} */
      const toolResult = invocation.executed ? invocation.result ?? null : null;

      const checks = evaluateCriteria(contract.acceptance_criteria, { toolResult });
      const requiredFailed = checks.filter((c) => c.required && c.verdict !== 'passed');
      const artifacts = /** @type {import('../core/types.mjs').ArtifactRef[]} */ (toolResult?.artifacts ?? []);
      /** @type {import('../core/types.mjs').TaskResult} */
      const result = {
        claims: invocation.executed
          ? [
              {
                claim: `ran ${tool_id} in the task workspace`,
                supported_by: toolResult?.exit_code === 0 ? 'exit_code 0' : null,
              },
            ]
          : [],
        artifacts,
        evidence: [
          { kind: 'decision', decision_id: admission.decision_id, arm_id: admission.arm_id },
          { kind: 'decision', decision_id: toolDecision.decision_id, arm_id: toolDecision.arm_id },
          { kind: 'invocation', status: invocation.status, exit_code: toolResult?.exit_code ?? null, duration_ms: invocation.duration_ms ?? null },
          { kind: 'workspace', path: workspace.path, entries: workspace.contents().length },
        ],
        checks,
        not_verified: checks.filter((c) => c.verdict === 'not_evaluated').map((c) => ({ id: c.id, detail: c.detail })),
        indeterminate: invocation.executed ? [] : [{ what: tool_id, why: 'the tool did not execute' }],
        decision_ids: [admission.decision_id, toolDecision.decision_id],
        tool: { tool_id, status: invocation.status, reason_code: invocation.reason_code ?? null },
      };
      taskStore.setResult(taskId, result);

      if (requiredFailed.length === 0) {
        taskStore.transition(taskId, 'completed', { reason: 'every required criterion passed', evidence: { requiredChecksPassed: true } });
        record({ event_type: 'task.completed', payload: { checks: checks.length, passed: checks.filter((c) => c.verdict === 'passed').length } });
        return { task_id: taskId, state: 'completed', admission, invocation, result, workspace: workspace.path };
      }

      taskStore.transition(taskId, 'failed', { reason: `${requiredFailed.length} required criteria did not pass` });
      record({
        event_type: 'task.failed',
        payload: {
          failed_checks: requiredFailed.map((c) => c.id),
          reason_code: invocation.status === 'denied' ? invocation.reason_code ?? 'DENIED' : 'CRITERIA_NOT_MET',
        },
      });
      return { task_id: taskId, state: 'failed', admission, invocation, result, workspace: workspace.path };
    },
  };
}

/**
 * Turn a JSON task file into the shape the runner validates. Kept next to the
 * runner so tests construct contracts exactly the way the CLI does.
 *
 * @param {Record<string, unknown>} raw
 * @param {{now?: () => number}} [options]
 */
export function contractFromJson(raw, options = {}) {
  const now = options.now ?? Date.now;
  return {
    objective: String(raw.objective ?? ''),
    acceptance_criteria: Array.isArray(raw.acceptance_criteria) ? raw.acceptance_criteria : [],
    capabilities: Array.isArray(raw.capabilities) ? raw.capabilities.map(String) : [],
    effect_class: raw.effect_class ?? 'local_reversible',
    workspace: typeof raw.workspace === 'string' ? raw.workspace : null,
    budget: raw.budget ?? {},
    requested_at: new Date(now()).toISOString(),
  };
}
