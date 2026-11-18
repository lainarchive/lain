import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SPECIALISTS,
  attenuateBudget,
  attenuateCapabilities,
  delegateTask,
} from '../../src/agent/delegate.mjs';
import { TASK_EVENT, eventBus } from '../../src/model/eventBus.mjs';

describe('Bounded Specialist Delegation (Phase 5)', () => {
  it('AT-P5-01: happy path specialist delegation runs bounded loop and verifies deliverable', async () => {
    let seenObjective = '';
    const res = await delegateTask({
      parentTaskId: 'parent-1',
      specialistId: 'researcher',
      objective: 'Summarize architecture constraints',
      contextNotes: 'Focus on fail-closed policy gates.',
      parentCapabilities: ['model.invoke', 'workspace.write'],
      parentBudget: { max_steps: 10, max_model_calls: 6, max_tool_calls: 4, max_wall_ms: 20_000 },
      transport: ({ messages }) => {
        seenObjective = messages[0]?.content ?? '';
        return { answer: JSON.stringify({ type: 'final', answer: 'summary-ready' }) };
      },
    });

    assert.equal(Object.isFrozen(SPECIALISTS), true);
    assert.equal(res.status, 'completed');
    assert.equal(res.specialist, 'researcher');
    assert.equal(res.depth, 1);
    assert.match(String(res.child_task_id), /^parent-1:child:researcher:/);
    assert.deepEqual(res.granted_capabilities, ['model.invoke']);
    assert.deepEqual(res.budget, {
      max_steps: 4,
      max_model_calls: 2,
      max_tool_calls: 0,
      max_wall_ms: 20_000,
    });
    assert.equal(res.verified, true);
    assert.equal(res.outcome.answer, 'summary-ready');
    assert.equal(seenObjective.includes('Summarize architecture constraints'), true);
    assert.equal(seenObjective.includes('Focus on fail-closed policy gates.'), true);
  });

  it('AT-P5-02: depth cap refusal and unknown/live-agent fail-closed guards', async () => {
    const depthRefused = await delegateTask({
      parentTaskId: 'parent-depth',
      specialistId: 'verifier',
      objective: 'Verify output',
      parentCapabilities: ['model.invoke'],
      parentBudget: { max_steps: 4, max_model_calls: 2, max_tool_calls: 0 },
      depth: 2,
      maxDepth: 2,
    });
    assert.deepEqual(depthRefused, {
      status: 'refused',
      reason: 'DELEGATION_DEPTH_EXCEEDED',
      depth: 2,
      max_depth: 2,
    });

    const unknownRefused = await delegateTask({
      parentTaskId: 'parent-unknown',
      specialistId: 'admin',
      objective: 'Should fail',
      parentCapabilities: ['model.invoke'],
      parentBudget: { max_steps: 4, max_model_calls: 2 },
    });
    assert.deepEqual(unknownRefused, {
      status: 'refused',
      reason: 'UNKNOWN_SPECIALIST',
    });

    const liveRefused = await delegateTask({
      parentTaskId: 'parent-live',
      specialistId: 'researcher',
      objective: 'Should fail',
      parentCapabilities: ['model.invoke'],
      parentBudget: { max_steps: 4, max_model_calls: 2 },
      activeChildren: 4,
      maxLiveAgents: 4,
    });
    assert.deepEqual(liveRefused, {
      status: 'refused',
      reason: 'MAX_LIVE_AGENTS_EXCEEDED',
    });
  });

  it('AT-P5-03: capability attenuation never escalates beyond parent or specialist', () => {
    assert.deepEqual(
      attenuateCapabilities(['model.invoke'], SPECIALISTS.implementer.allowed_capabilities, [
        'model.invoke',
        'workspace.write',
        'process.spawn',
        'admin.root',
      ]),
      ['model.invoke'],
    );

    assert.deepEqual(
      attenuateCapabilities(
        ['model.invoke', 'workspace.write', 'process.spawn', 'network.egress'],
        SPECIALISTS.researcher.allowed_capabilities,
        ['model.invoke', 'workspace.write', 'network.egress'],
      ),
      ['model.invoke'],
    );

    assert.deepEqual(
      attenuateCapabilities(
        ['model.invoke', 'workspace.write'],
        SPECIALISTS.implementer.allowed_capabilities,
        undefined,
      ),
      ['model.invoke', 'workspace.write'],
    );

    assert.deepEqual(
      attenuateCapabilities(['model.invoke'], SPECIALISTS.implementer.allowed_capabilities, []),
      [],
    );
  });

  it('AT-P5-04: budget attenuation clamps to parent remaining and positive integers', async () => {
    assert.deepEqual(
      attenuateBudget(
        { max_steps: 3, max_model_calls: 1.9, max_tool_calls: 2, max_wall_ms: 5_000 },
        { max_steps: 8, max_model_calls: 4, max_tool_calls: 4, max_wall_ms: 30_000 },
      ),
      { max_steps: 3, max_model_calls: 1, max_tool_calls: 2, max_wall_ms: 5_000 },
    );

    const zeroBudgetRefusal = await delegateTask({
      parentTaskId: 'parent-budget-0',
      specialistId: 'implementer',
      objective: 'Run out of budget',
      parentCapabilities: ['model.invoke', 'workspace.write'],
      parentBudget: { max_steps: 4, max_model_calls: 0, max_tool_calls: 2 },
    });
    assert.deepEqual(zeroBudgetRefusal, {
      status: 'refused',
      reason: 'BUDGET_EXCEEDED',
    });
  });

  it('AT-P5-05: independent verification hook failure yields verification_failed', async () => {
    const res = await delegateTask({
      parentTaskId: 'parent-verify-fail',
      specialistId: 'implementer',
      objective: 'Produce deliverable',
      parentCapabilities: ['model.invoke', 'workspace.write'],
      parentBudget: { max_steps: 8, max_model_calls: 4, max_tool_calls: 4, max_wall_ms: 30_000 },
      transport: () => ({ answer: JSON.stringify({ type: 'final', answer: 'claim-done' }) }),
      verifyDeliverable: async (outcome) => ({
        ok: false,
        note: `missing evidence for ${outcome.answer}`,
      }),
    });

    assert.equal(res.status, 'verification_failed');
    assert.equal(res.verified, false);
    assert.equal(res.verification_note, 'missing evidence for claim-done');
    assert.equal(res.outcome.status, 'completed');
  });

  it('AT-P5-06: emits delegation.started and delegation.completed/failed to record and eventBus', async () => {
    const recorded = [];
    const busEvents = [];
    const onEvent = (evt) => busEvents.push(evt);
    eventBus.on(TASK_EVENT, onEvent);

    try {
      await delegateTask({
        parentTaskId: 'parent-events-ok',
        specialistId: 'verifier',
        objective: 'Check invariants',
        parentCapabilities: ['model.invoke'],
        parentBudget: { max_steps: 4, max_model_calls: 2, max_tool_calls: 0, max_wall_ms: 30_000 },
        record: (evt) => recorded.push(evt),
      });

      await delegateTask({
        parentTaskId: 'parent-events-fail',
        specialistId: 'verifier',
        objective: 'Fail verification',
        parentCapabilities: ['model.invoke'],
        parentBudget: { max_steps: 4, max_model_calls: 2, max_tool_calls: 0, max_wall_ms: 30_000 },
        record: (evt) => recorded.push(evt),
        verifyDeliverable: () => {
          throw new Error('verifier crashed');
        },
      });
    } finally {
      eventBus.off(TASK_EVENT, onEvent);
    }

    const delegationRecorded = recorded.filter((e) => e.event_type.startsWith('delegation.'));
    assert.deepEqual(
      delegationRecorded.map((e) => e.event_type),
      ['delegation.started', 'delegation.completed', 'delegation.started', 'delegation.failed'],
    );

    const delegationBus = busEvents.filter((e) => e.event_type.startsWith('delegation.'));
    assert.deepEqual(
      delegationBus.map((e) => e.event_type),
      ['delegation.started', 'delegation.completed', 'delegation.started', 'delegation.failed'],
    );
    assert.equal(delegationBus[0].payload.parent_task_id, 'parent-events-ok');
    assert.equal(delegationBus[3].payload.verification_note, 'verifier crashed');
  });

  it('AT-P5-07: omitted parentBudget fails closed and loop refusal preserves status refused', async () => {
    const emptyBudget = await delegateTask({
      parentTaskId: 'parent-empty-budget',
      specialistId: 'researcher',
      objective: 'Should refuse',
      parentCapabilities: ['model.invoke'],
      parentBudget: {},
    });
    assert.deepEqual(emptyBudget, { status: 'refused', reason: 'BUDGET_EXCEEDED' });

    const refused = await delegateTask({
      parentTaskId: 'parent-no-cap',
      specialistId: 'researcher',
      objective: 'Should refuse on policy',
      parentCapabilities: [],
      parentBudget: { max_steps: 4, max_model_calls: 2, max_tool_calls: 0, max_wall_ms: 30_000 },
    });
    assert.equal(refused.status, 'refused');
    assert.equal(refused.verified, false);
  });
});
