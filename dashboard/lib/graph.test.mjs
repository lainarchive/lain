import assert from 'node:assert/strict';
import test from 'node:test';
import { applyEvent, emptyGraph, layoutNodes } from './graph.ts';

function run(events, session = 's', initial = emptyGraph) {
  return events.reduce((graph, event, index) => applyEvent(graph, {
    event, session_id: session, sequence: initial.cursor + index + 1,
    timestamp_ms: 1000 + index * 25,
  }), initial);
}

const intent = { type: 'intent_received', text: 'Fix the boundary' };
const turn = { type: 'turn_started', session_id: 's', turn: 1 };
const invoke = (call_id = 'c', name = 'Bash') => ({
  type: 'tool_invoked', turn: 1, call_id, name, arguments: { command: 'check' },
});
const complete = (outcome, call_id = 'c') => ({
  type: 'tool_completed', turn: 1, call_id, name: 'Bash', outcome,
});

test('reasoning survives completion and termination without truncating its payload', () => {
  const text = 'reasoning '.repeat(8000);
  for (const ending of [
    { type: 'turn_completed', turn: 1, tool_calls: 0, tokens_used: 10 },
    { type: 'terminated', turn: 1, reason: { reason: 'cancelled' } },
  ]) {
    const graph = run([intent, turn,
      { type: 'thinking_token', turn: 1, text },
      { type: 'thinking_token', turn: 1, text: 'end' }, ending]);
    const reasoning = graph.nodes.find(node => node.kind === 'reasoning');
    assert.equal(reasoning.output, `${text}end`);
    assert.equal(reasoning.duration, 75);
    assert.equal(reasoning.status, ending.type === 'terminated' ? 'failed' : 'success');
  }
});

test('tool approval, failure and diffs retain full I/O and timing', () => {
  let graph = run([intent, turn, invoke(), {
    type: 'approval_required', turn: 1, call_id: 'c', name: 'Bash', arguments: {},
  }]);
  assert.equal(graph.nodes.at(-1).status, 'pending');
  assert.deepEqual(graph.nodes.at(-1).input, { command: 'check' });
  graph = run([complete({ outcome: 'succeeded', content: '--- a/file\n+++ b/file\n+fixed', exit_code: 0 })], 's', graph);
  assert.equal(graph.nodes.at(-1).status, 'success');
  assert.match(graph.nodes.at(-1).diff, /\+fixed/);
  for (const outcome of [
    { outcome: 'succeeded', content: 'exit failed', exit_code: 1 },
    { outcome: 'failed', code: 'TOOL_ERROR', message: 'bad input' },
    { outcome: 'skipped', reason: 'Denied by operator' },
    { outcome: 'interrupted', reason: 'cancelled' },
  ]) {
    const failed = run([intent, turn, invoke(), complete(outcome)]).nodes.at(-1);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.duration, 25);
    assert.deepEqual(failed.result, outcome);
    assert.ok(failed.detail);
  }
});

test('DAG links parallel tools to reasoning and the next turn to all tool results', () => {
  const graph = run([intent, turn, invoke('a'), invoke('b', 'DelegateAgent'),
    complete({ outcome: 'succeeded', content: 'a', exit_code: 0 }, 'a'),
    complete({ outcome: 'succeeded', content: 'b', exit_code: 0 }, 'b'),
    { type: 'turn_completed', turn: 1, tool_calls: 2, tokens_used: 10 },
    { ...turn, turn: 2 },
  ]);
  assert.deepEqual(graph.nodes.find(node => node.id === 's:turn:2').parents, ['s:tool:1:a', 's:tool:1:b']);
  assert.equal(graph.nodes.find(node => node.label === 'DelegateAgent').kind, 'subagent');
  const positioned = layoutNodes(graph.nodes);
  for (const node of positioned) {
    for (const parent of node.parents ?? []) {
      assert.ok(positioned.find(candidate => candidate.id === parent).x < node.x);
    }
  }
});

test('replay duplicates are ignored and missing history is surfaced', () => {
  const graph = run([intent]);
  assert.equal(applyEvent(graph, { event: intent, session_id: 's', sequence: 1, timestamp_ms: 1000 }), graph);
  const gap = applyEvent(emptyGraph, { event: intent, session_id: 's', sequence: 9, timestamp_ms: 1000 });
  assert.equal(gap.gap, true);
  assert.equal(run([]), emptyGraph);
});

test('compact layout leaves a gap around 200 by 56 nodes', () => {
  assert.deepEqual(layoutNodes([]), []);
  const nodes = [
    { id: 'intent' },
    { id: 'a', parents: ['intent'] },
    { id: 'b', parents: ['intent'] },
  ];
  const [intent, a, b] = layoutNodes(nodes);
  assert.equal(a.x - intent.x, 244);
  assert.equal(b.x, a.x);
  assert.equal(b.y - a.y, 88);
  assert.deepEqual(nodes[0], { id: 'intent' });
});

test('reflection retains its summary and rules and sessions remain isolated', () => {
  let graph = run([intent, turn]);
  graph = run([{ type: 'intent_received', text: 'other' }], 'other', graph);
  graph = run([{ type: 'reflection_generated', summary: 'Learned boundary', rules: ['Validate first'] }], 's', graph);
  const reflection = graph.nodes.at(-1);
  assert.deepEqual(reflection.output, { summary: 'Learned boundary', rules: ['Validate first'] });
  assert.ok(reflection.parents.every(id => id.startsWith('s:')));
});
