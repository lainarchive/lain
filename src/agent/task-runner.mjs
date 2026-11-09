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
import { createApprovalLedger } from '../policy/approvals.mjs';
import { createWorkspace } from '../exec/workspace.mjs';
import { createInvoker } from '../tools/invoke.mjs';
import { createCanceller } from './cancel.mjs';
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
 * Pre-authorise one tool, and record the flag that did it.
 *
 * `--allow` is not an answer to a question: nobody was asked. A grant the log
 * cannot tell apart from a person's answer is a grant nobody can audit, so the
 * question is asked and answered in the same breath and `decided_by` reads
 * `flag:<source>` — never `human:<name>`. The record outlives the run, which is
 * what lets `lain approve --list` show what was granted, by what, and to which
 * digest.
 *
 * @param {{allow?: string[], by?: string|null, path?: string}} approvals
 * @param {{action: string, tool_id: string, target: string, effect_class: string, task_id: string}} question
 * @returns {{status: 'granted', approval_id: string}} the record's id; its provenance lives in the ledger
 */
function flagGrant(approvals, question) {
  const ledger = approvals.path ? createApprovalLedger({ path: approvals.path }) : createApprovalLedger({});
  const asked = ledger.request(question);
  const answered = ledger.answer(asked.approval_id, 'granted', { by: approvals.by ?? 'cli', source: 'flag' });
  return { status: 'granted', approval_id: answered.approval_id };
}

/**
 * @param {object} args
 * @param {import('../core/types.mjs').TaskStore} args.taskStore
 * @param {(info: {task_id: string}) => import('../core/types.mjs').EventLog} args.openLog
 * @param {import('../core/types.mjs').Registry} args.registry
 * @param {import('../policy/rules.mjs').RuleSet} args.rules
 * @param {string} args.workspaceRoot
 * @param {(workspace: import('../core/types.mjs').WorkspaceHandle) => import('../tools/registry.mjs').ToolDefinition} args.makeTool
 * @param {{allow?: string[], by?: string|null, path?: string}} [args.approvals] granted by a flag, never by a person
 * @param {() => number} [args.now]
 * @param {(task_id: string) => import('./cancel.mjs').JobControl|null} [args.jobControl] the execution layer's job handle
 * @param {string|null} [args.containerSid] the AppContainer to launch tools into, or null for a declared run
 * @param {import('./cancel.mjs').Canceller} [args.canceller] use this cascade instead of building one
 * @param {number} [args.deadlineMs] how long a cancellation may take before a human is called
 * @param {(request: import('./cancel.mjs').CancelRequest) => void} [args.escalate]
 * @returns {{
 *   run: (args: {
 *     contract: import('../core/types.mjs').TaskContract,
 *     tool_id: string,
 *     tool_arguments: Record<string, unknown>,
 *     origin?: string,
 *     cancel_after_ms?: number,
 *   }) => Promise<import('../core/types.mjs').RunnerOutcome>,
 *   cancel: (taskId: string, options?: import('./cancel.mjs').CancelOptions) => Promise<import('./cancel.mjs').CancelRequest>,
 *   canceller: import('./cancel.mjs').Canceller,
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
  jobControl,
  canceller,
  deadlineMs,
  escalate,
  containerSid = null,
}) {
  // The cascade is built here so that the runner owns the whole lifecycle of the
  // task it created — including stopping it. A caller may inject one instead
  // (tests do), but never gets two: two cascades over one task would each think
  // they were the one that closed admission.
  const cascade =
    canceller ??
    createCanceller({ taskStore, openLog, jobControl, workspaceRoot, now, deadlineMs, escalate });

  return {
    /**
     * @param {object} args
     * @param {import('../core/types.mjs').TaskContract} args.contract
     * @param {string} args.tool_id
     * @param {Record<string, unknown>} args.tool_arguments
     * @param {string} [args.origin]
     * @param {number} [args.cancel_after_ms] ask for a stop this long after execution starts
     * @returns {Promise<import('../core/types.mjs').RunnerOutcome>}
     */
    async run({ contract, tool_id, tool_arguments, origin = 'cli', cancel_after_ms }) {
      const created = taskStore.create({ contract, origin });
      const taskId = created.task_id;
      const log = openLog({ task_id: taskId });
      const record = (/** @type {{event_type: string, payload?: Record<string, unknown>, correlation_id?: string, causation_id?: string}} */ event) =>
        log.record(event.event_type, event.payload ?? {}, {
          // The events table carries the task id in its own column, so a task's
          // whole story is one indexed query — including the rows this runner
          // writes, which are the ones a cancellation has to be read against.
          task_id: taskId,
          correlation_id: event.correlation_id,
          causation_id: event.causation_id,
        });

      record({ event_type: 'task.created', payload: { objective: contract.objective, effect_class: contract.effect_class } });

      const cancelAfter = typeof cancel_after_ms === 'number' && Number.isFinite(cancel_after_ms) ? cancel_after_ms : null;
      /** @type {ReturnType<typeof setTimeout>|null} */
      let cancelTimer = null;
      /** @type {Promise<'cancelled'>|null} */
      let cancelSettled = null;

      const disarm = () => {
        if (cancelTimer) {
          clearTimeout(cancelTimer);
          cancelTimer = null;
        }
      };

      // The timer is a request, not a kill: it goes through the cascade, which
      // writes the terminal intent before anything is signalled. It is cleared on
      // every exit so a finished run leaves no late cancellation behind it.
      /**
       * @param {number} ms
       */
      const arm = (ms) => {
        cancelSettled = new Promise((resolve) => {
          cancelTimer = setTimeout(() => {
            void (async () => {
              try {
                await cascade.requestCancellation(taskId, {
                  reason: `given ${ms} ms, the task did not finish`,
                  reason_code: 'CANCEL_AFTER_ELAPSED',
                  requested_by: origin,
                });
              } catch (err) {
                record({ event_type: 'task.cancel.request_failed', payload: { detail: err instanceof Error ? err.message : String(err) } });
              }
              resolve('cancelled');
            })();
          }, ms);
        });
      };

      /**
       * Is the task still where the runner left it? A cancellation moves it to
       * `cancelling` while a tool is in flight, and the runner has to stop rather
       * than write over the cascade: `cancelling -> completed` is not a legal
       * edge, and a "completed" result written after a cancellation would be a
       * lie about a task that was stopped.
       *
       * @param {string} expected
       * @returns {Promise<string|null>} the state that took over, or null
       */
      const takenOverState = async (expected) => {
        const observed = taskStore.get(taskId).state;
        if (observed === expected) return null;
        const inFlight = cascade.settled(taskId);
        if (inFlight) {
          try {
            await inFlight;
          } catch {
            // The cascade records its own failure. The runner's job here is only
            // to not fight it for the last write.
          }
        }
        return taskStore.get(taskId).state;
      };

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

      // A tool-call ceiling that is read but never advanced is not a ceiling.
      // This counter is the one place the budget is spent, and the admission
      // decision below is where it is checked, so the refusal happens before a
      // workspace exists rather than after the effect.
      let toolCallsMade = 0;

      const admission = decide(
        {
          action: 'task.admit',
          target: tool_id,
          task_id: taskId,
          requested_capabilities: contract.capabilities,
          effect_class: contract.effect_class,
          requested_by: origin,
        },
        buildContext({
          rules,
          tool_id,
          granted_capabilities: policySees,
          budget: { exceeded: toolCallsMade >= contract.budget.max_tool_calls },
          approval: { status: null },
          complete: true,
        }),
      );

      if (admission.outcome !== 'allow' && admission.outcome !== 'allow_with_conditions') {
        taskStore.transition(taskId, 'failed', { reason: `admission refused: ${admission.reason_code}` });
        record({ event_type: 'task.failed', payload: { reason_code: admission.reason_code, decision_id: admission.decision_id } });
        return { task_id: taskId, state: 'failed', admission, invocation: null, result: null, workspace: null };
      }

      // A cancel can land between the create above and this line, and since
      // `submitted -> cancelling` is legal that is a real race rather than a
      // theoretical one: the cascade would take the task to `cancelling` and
      // this transition would throw ILLEGAL_TRANSITION, rejecting the whole run
      // on a task that is already settling correctly. The check is
      // deliberately observational rather than `takenOverState`, which awaits an
      // in-flight cascade — here that would let a cancel that has not landed yet
      // steal the run's own admission, and the run has done nothing yet, so the
      // request ought to be the cascade's to record. Read, write, and if the
      // write is refused, the answer is the same either way.
      const stateBeforeAdmit = taskStore.get(taskId).state;
      let cancelledDuringAdmission = stateBeforeAdmit !== 'submitted';
      if (!cancelledDuringAdmission) {
        try {
          taskStore.transition(taskId, 'admitted', { reason: `admitted by ${admission.arm_id}` });
        } catch {
          cancelledDuringAdmission = true;
        }
      }
      if (cancelledDuringAdmission) {
        record({
          event_type: 'task.run.abandoned',
          payload: {
            expected: 'submitted',
            observed: taskStore.get(taskId).state,
            reason_code: 'CANCELLED_DURING_ADMISSION',
          },
        });
        return { task_id: taskId, state: taskStore.get(taskId).state, admission, invocation: null, result: null, workspace: null };
      }
      record({ event_type: 'task.admitted', payload: { decision_id: admission.decision_id, arm_id: admission.arm_id } });

      // Capabilities are granted once, at admission, and only for the tools that
      // will actually run. Nothing after this line may add to the set.
      const granted = taskStore.grantCapabilities(taskId, grantedCaps, { granted_by: `policy:${admission.arm_id}` });

      const provisionalWorkspace = { path: join(workspaceRoot, taskId) };
      // The effect class comes from the rule set, not from the registry: the
      // registry has no tool until one is bound to a workspace, and the rule
      // set is the authority anyway. Reading a missing tool as "unknown,
      // therefore external" would make every unregistered tool look like the
      // most dangerous class — the right refusal, for the wrong reason.
      const toolEffectClass = registry.get(tool_id)?.effect_class ?? toolRule(rules, tool_id)?.tool_effect_class ?? 'external';

      // The tool decision is taken *before* anything is created on disk, so a
      // refusal costs nothing and leaves no artefact to clean up.
      /** @type {{status: 'granted'|'denied'|'pending'|'timed_out'|null, approval_id?: string}} */
      const toolApproval = approvals.allow?.includes(tool_id)
        ? flagGrant(approvals, {
            action: `tool.${tool_id}`,
            tool_id,
            target: provisionalWorkspace.path,
            effect_class: toolEffectClass,
            task_id: taskId,
          })
        : { status: null };
      const toolDecision = decide(
        {
          action: `tool.${tool_id}`,
          target: provisionalWorkspace.path,
          task_id: taskId,
          requested_capabilities: granted,
          effect_class: toolEffectClass,
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
      //
      // This is also the first point where a stop can be asked for: the timer
      // starts with execution rather than during admission, and an already
      // cancelling task never gets a workspace.
      if (cancelAfter !== null) arm(cancelAfter);
      const beforeEffect = await takenOverState('admitted');
      if (beforeEffect) {
        disarm();
        record({ event_type: 'task.run.abandoned', payload: { expected: 'admitted', observed: beforeEffect, reason_code: 'CANCELLED_BEFORE_EFFECT' } });
        return { task_id: taskId, state: beforeEffect, admission, invocation: null, result: null, workspace: null };
      }

      const workspace = createWorkspace({
        root: workspaceRoot,
        task_id: taskId,
        forbidden: rules.forbidden_paths,
        now,
        // The posture decides whether the tool is launched into an AppContainer.
        // Without this the `kernel` posture would be a promise the run path never
        // kept: the boundary check would pass, the task would complete, and the
        // tool would have run with the user's own read rights the whole time.
        // That is the exact failure this project keeps recording, so it is wired
        // here rather than left to the CLI to remember.
        container: containerSid ?? undefined,
      });
      workspace.create();
      record({
        event_type: 'workspace.created',
        payload: { path: workspace.path, container: containerSid ? 'appcontainer' : 'none' },
      });

      // Same race as admission, one effect closer, but the check here has to be
      // purely observational: awaiting an in-flight cascade would let a cancel
      // that has not landed yet pre-empt the run, and the request belongs to the
      // run once a tool is on the way. So: read the state, and if it is still
      // `admitted`, take the write. If a cancel slips into the microseconds
      // between the read and the write the transition is refused, and that is
      // the same answer arrived at differently — the cascade owns the task, this
      // run stops, and the workspace goes with it because a task that never ran
      // should not leave one behind.
      const stateBeforeRunning = taskStore.get(taskId).state;
      let cancelledBeforeRunning = stateBeforeRunning !== 'admitted';
      if (!cancelledBeforeRunning) {
        try {
          taskStore.transition(taskId, 'running', { reason: 'executing one tool' });
        } catch {
          cancelledBeforeRunning = true;
        }
      }
      if (cancelledBeforeRunning) {
        disarm();
        record({
          event_type: 'task.run.abandoned',
          payload: {
            expected: 'admitted',
            observed: taskStore.get(taskId).state,
            reason_code: 'CANCELLED_BEFORE_EFFECT',
          },
        });
        workspace.destroy();
        return { task_id: taskId, state: taskStore.get(taskId).state, admission, invocation: null, result: null, workspace: null };
      }
      record({ event_type: 'task.running', payload: { tool_id } });

      registry.register(makeTool(workspace));

      const invoker = createInvoker({
        registry,
        record: (event) => log.record(event.event_type, event.payload ?? {}, { correlation_id: event.correlation_id, causation_id: event.causation_id }),
        workspace,
      });
      /** @type {Promise<import('../core/types.mjs').ToolOutcome>} */
      const invocationPromise = invoker.invoke({
        tool_id,
        arguments: tool_arguments,
        decision: toolDecision,
        task_id: taskId,
        capabilities: granted,
        budget: {
          remaining_tool_calls: contract.budget.max_tool_calls - toolCallsMade,
          max_output_bytes: contract.budget.max_output_bytes,
          max_wall_ms: contract.budget.max_wall_ms,
        },
      });
      /** @type {import('../core/types.mjs').ToolOutcome} */
      let invocation;
      // `arm` is the only writer of this, so the checker's narrowing to null does
      // not hold here; the declared union is the truth.
      const pendingCancel = /** @type {Promise<'cancelled'>|null} */ (cancelSettled);
      if (pendingCancel) {
        // Bounded time means bounded. If the cancellation settles first, the run
        // stops here rather than waiting for a tool that may never return.
        const raced = await Promise.race([
          invocationPromise.then(
            (value) => ({ kind: 'invocation', value, error: null }),
            (error) => ({ kind: 'invocation', value: null, error }),
          ),
          pendingCancel.then(() => ({ kind: 'cancelled', value: null, error: null })),
        ]);
        if (raced.kind === 'cancelled') {
          disarm();
          const settledState = taskStore.get(taskId).state;
          record({ event_type: 'task.run.abandoned', payload: { expected: 'running', observed: settledState, reason_code: 'CANCEL_AFTER_ELAPSED' } });
          return { task_id: taskId, state: settledState, admission, invocation: null, result: null, workspace: workspace.path };
        }
        if (raced.error) throw raced.error;
        invocation = /** @type {import('../core/types.mjs').ToolOutcome} */ (raced.value);
      } else {
        invocation = await invocationPromise;
      }

      // Spent once the invocation is in hand, whether it succeeded or not: a
      // refused or failed call is still a call the budget paid for, and only an
      // abandoned run (the races above) returns without charging one.
      toolCallsMade += 1;

      // -- the stop may have landed while the tool was running. If it did, the
      //    cascade owns the last write: the runner returns what the task actually
      //    became instead of overwriting it with its own verdict.
      const afterTool = await takenOverState('running');
      if (afterTool) {
        disarm();
        record({ event_type: 'task.run.abandoned', payload: { expected: 'running', observed: afterTool, reason_code: 'CANCELLED_UNDER_RUN' } });
        return { task_id: taskId, state: afterTool, admission, invocation, result: null, workspace: workspace.path };
      }

      // The run has the last word now: the checkpoint above passed while the task
      // was still `running`, so nothing else is moving it. Clear the timer before
      // the settle writes, and a late cancellation cannot land on a finished task.
      disarm();

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
    /**
     * Stop a task this runner started — or any task in the same store, because the
     * cascade is keyed by task id and the store is shared.
     *
     * @param {string} taskId
     * @param {import('./cancel.mjs').CancelOptions} [options]
     * @returns {Promise<import('./cancel.mjs').CancelRequest>}
     */
    cancel(taskId, options = {}) {
      return cascade.requestCancellation(taskId, options);
    },
    /** The cascade itself, for callers that want `pending()` or `settled()`. */
    canceller: cascade,
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
