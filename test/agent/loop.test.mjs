import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseModelAction, runModelLoop } from '../../src/agent/loop.mjs';
import { TASK_EVENT, eventBus } from '../../src/model/eventBus.mjs';
import { decide } from '../../src/policy/decide.mjs';
import { DEFAULT_RULES, buildContext } from '../../src/policy/rules.mjs';

function permitTool(toolId, caps = ['workspace.read']) {
  const ctx = buildContext({
    rules: DEFAULT_RULES,
    tool_id: toolId,
    granted_capabilities: caps,
    budget: { exceeded: false },
    complete: true,
  });
  return decide(
    {
      action: 'tool.invoke',
      target: toolId,
      tool_id: toolId,
      effect_class: 'read_only',
      requested_capabilities: caps,
    },
    ctx,
  );
}

describe('parseModelAction', () => {
  it('accepts plain JSON, fenced ```json blocks, and objects', () => {
    const fenced = parseModelAction('```json\n{"type":"final","answer":"done"}\n```');
    assert.deepEqual(fenced, { ok: true, action: { type: 'final', answer: 'done' } });

    const obj = parseModelAction({ type: 'tool', tool_id: 'read_file', arguments: { path: 'a.txt' } });
    assert.deepEqual(obj, {
      ok: true,
      action: { type: 'tool', tool_id: 'read_file', arguments: { path: 'a.txt' } },
    });

    const noArgs = parseModelAction('{"type":"tool","tool_id":"read_file"}');
    assert.deepEqual(noArgs, {
      ok: true,
      action: { type: 'tool', tool_id: 'read_file', arguments: {} },
    });
  });

  it('rejects malformed JSON and invalid shapes', () => {
    assert.equal(parseModelAction('not-json').ok, false);
    assert.equal(parseModelAction(null).ok, false);
    assert.equal(parseModelAction([]).ok, false);
    assert.equal(parseModelAction({ type: 'final', answer: 123 }).ok, false);
    assert.equal(parseModelAction({ type: 'tool', tool_id: '' }).ok, false);
    assert.equal(parseModelAction({ type: 'tool', tool_id: 'read_file', arguments: ['bad'] }).ok, false);
    assert.equal(parseModelAction({ type: 'unknown' }).ok, false);
  });
});

describe('runModelLoop (M-10)', () => {
  it('AT-M10-01: happy path tool -> final and default mock transport', async () => {
    const defaultRes = await runModelLoop({
      taskId: 't-default',
      objective: 'ping',
      granted_capabilities: ['model.invoke'],
    });
    assert.equal(defaultRes.status, 'completed');
    assert.equal(defaultRes.answer, 'mock-ok');
    assert.equal(defaultRes.steps, 1);
    assert.equal(defaultRes.model_calls, 1);
    assert.equal(defaultRes.tool_calls, 0);

    const invoked = [];
    let turn = 0;
    const res = await runModelLoop({
      taskId: 't-happy',
      objective: 'read note.txt',
      granted_capabilities: ['model.invoke', 'workspace.read'],
      toolDecisions: { read_file: permitTool('read_file') },
      invoker: {
        async invoke(call) {
          invoked.push(call);
          return { status: 'ok', content: 'hello-world' };
        },
      },
      transport: ({ messages }) => {
        turn += 1;
        if (turn === 1) {
          return { answer: '```json\n{"type":"tool","tool_id":"read_file","arguments":{"path":"note.txt"}}\n```' };
        }
        assert.equal(messages.some((m) => m.role === 'tool' && m.content.includes('hello-world')), true);
        return { answer: JSON.stringify({ type: 'final', answer: 'file says hello-world' }) };
      },
    });

    assert.equal(res.status, 'completed');
    assert.equal(res.answer, 'file says hello-world');
    assert.equal(res.steps, 2);
    assert.equal(res.model_calls, 2);
    assert.equal(res.tool_calls, 1);
    assert.equal(invoked.length, 1);
    assert.equal(invoked[0].tool_id, 'read_file');
  });

  it('AT-M10-02: policy refusal before model call and fail-closed tool gate', async () => {
    let called = false;
    const refusedModel = await runModelLoop({
      taskId: 't-refuse-model',
      objective: 'should not run',
      granted_capabilities: [],
      transport: () => {
        called = true;
        return { answer: '{"type":"final","answer":"nope"}' };
      },
    });
    assert.equal(called, false);
    assert.equal(refusedModel.status, 'refused');
    assert.equal(refusedModel.reason, 'CAPABILITY_NOT_GRANTED');
    assert.equal(refusedModel.model_calls, 0);

    const refusedLive = await runModelLoop({
      taskId: 't-refuse-live',
      objective: 'live without approval',
      live: true,
      granted_capabilities: ['model.invoke'],
    });
    assert.equal(refusedLive.status, 'refused');
    assert.equal(refusedLive.reason, 'CAPABILITY_NOT_GRANTED');

    const approvedLive = await runModelLoop({
      taskId: 't-approved-live',
      objective: 'live with bound approval',
      live: true,
      approvalId: 'apr-1',
      ledger: {
        list: () => [{ decision_id: 'apr-1', taskId: 't-approved-live', modelId: 'm', outcome: 'granted' }],
      },
    });
    assert.equal(approvedLive.status, 'completed');

    const refusedTool = await runModelLoop({
      taskId: 't-refuse-tool',
      objective: 'try unpermitted tool',
      granted_capabilities: ['model.invoke'],
      invoker: null,
      transport: () => ({ answer: '{"type":"tool","tool_id":"read_file","arguments":{}}' }),
    });
    assert.equal(refusedTool.status, 'refused');
    assert.equal(refusedTool.reason, 'TOOL_NOT_PERMITTED');
    assert.equal(refusedTool.tool_calls, 0);
  });

  it('AT-M10-03: model call and step budget circuit breakers', async () => {
    const modelBudgetRes = await runModelLoop({
      taskId: 't-model-budget',
      objective: 'loop tools',
      granted_capabilities: ['model.invoke', 'workspace.read'],
      budget: { max_steps: 10, max_model_calls: 2, max_tool_calls: 10 },
      toolDecisions: { read_file: permitTool('read_file') },
      invoker: { invoke: async () => ({ status: 'ok' }) },
      transport: () => ({ answer: '{"type":"tool","tool_id":"read_file","arguments":{}}' }),
    });
    assert.equal(modelBudgetRes.status, 'budget_exceeded');
    assert.equal(modelBudgetRes.reason, 'MODEL_CALL_BUDGET');
    assert.equal(modelBudgetRes.model_calls, 2);

    const stepBudgetRes = await runModelLoop({
      taskId: 't-step-budget',
      objective: 'hit step cap',
      granted_capabilities: ['model.invoke', 'workspace.read'],
      budget: { max_steps: 1, max_model_calls: 5, max_tool_calls: 5 },
      toolDecisions: { read_file: permitTool('read_file') },
      invoker: { invoke: async () => ({ status: 'ok' }) },
      transport: () => ({ answer: '{"type":"tool","tool_id":"read_file","arguments":{}}' }),
    });
    assert.equal(stepBudgetRes.status, 'budget_exceeded');
    assert.equal(stepBudgetRes.reason, 'STEP_BUDGET');
    assert.equal(stepBudgetRes.steps, 1);
  });

  it('AT-M10-04: tool call budget circuit breaker', async () => {
    const res = await runModelLoop({
      taskId: 't-tool-budget',
      objective: 'exceed tool calls',
      granted_capabilities: ['model.invoke', 'workspace.read'],
      budget: { max_steps: 6, max_model_calls: 6, max_tool_calls: 1 },
      toolDecisions: { read_file: permitTool('read_file') },
      invoker: { invoke: async () => ({ status: 'ok' }) },
      transport: () => ({ answer: '{"type":"tool","tool_id":"read_file","arguments":{}}' }),
    });
    assert.equal(res.status, 'budget_exceeded');
    assert.equal(res.reason, 'TOOL_CALL_BUDGET');
    assert.equal(res.tool_calls, 1);
  });

  it('AT-M10-05: wall clock budget circuit breaker', async () => {
    let clock = 1000;
    const res = await runModelLoop({
      taskId: 't-wall-budget',
      objective: 'timeout',
      granted_capabilities: ['model.invoke', 'workspace.read'],
      budget: { max_wall_ms: 50 },
      now: () => clock,
      toolDecisions: { read_file: permitTool('read_file') },
      invoker: { invoke: async () => ({ status: 'ok' }) },
      transport: () => {
        clock += 60;
        return { answer: '{"type":"tool","tool_id":"read_file","arguments":{}}' };
      },
    });
    assert.equal(res.status, 'budget_exceeded');
    assert.equal(res.reason, 'WALL_CLOCK_BUDGET');
  });

  it('AT-M10-06: 1-retry malformed recovery and fail closed on 2nd consecutive malformed', async () => {
    let attempt = 0;
    const recovered = await runModelLoop({
      taskId: 't-recover',
      objective: 'recover',
      granted_capabilities: ['model.invoke'],
      transport: () => {
        attempt += 1;
        if (attempt === 1) return { answer: 'not valid json' };
        return { answer: '{"type":"final","answer":"recovered"}' };
      },
    });
    assert.equal(recovered.status, 'completed');
    assert.equal(recovered.answer, 'recovered');
    assert.equal(recovered.model_calls, 2);

    const failed = await runModelLoop({
      taskId: 't-malformed-fail',
      objective: 'always malformed',
      granted_capabilities: ['model.invoke'],
      transport: () => ({ answer: 'still-not-json' }),
    });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.reason, 'MALFORMED_MODEL_ACTION');
    assert.equal(failed.model_calls, 2);
  });

  it('AT-M10-07: emits loop events to both record() and eventBus', async () => {
    const recorded = [];
    const busEvents = [];
    const listener = (evt) => {
      if (evt.task_id === 't-events') busEvents.push(evt);
    };
    eventBus.on(TASK_EVENT, listener);

    try {
      let step = 0;
      const res = await runModelLoop({
        taskId: 't-events',
        objective: 'emit events',
        granted_capabilities: ['model.invoke', 'workspace.read'],
        record: (evt) => recorded.push(evt.event_type),
        toolDecisions: { read_file: permitTool('read_file') },
        invoker: { invoke: async () => ({ status: 'ok' }) },
        transport: () => {
          step += 1;
          if (step === 1) return { answer: '{"type":"tool","tool_id":"read_file","arguments":{}}' };
          return { answer: '{"type":"final","answer":"all-emitted"}' };
        },
      });
      assert.equal(res.status, 'completed');
    } finally {
      eventBus.off(TASK_EVENT, listener);
    }

    const expectedTypes = ['loop.started', 'model.invoked', 'tool.dispatched', 'model.invoked', 'loop.completed'];
    assert.deepEqual(recorded, expectedTypes);
    assert.deepEqual(
      busEvents.map((e) => e.event_type),
      expectedTypes,
    );
  });
});
