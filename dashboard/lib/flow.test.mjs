import assert from 'node:assert/strict';
import test from 'node:test';
import { updatePositions, graphEdges, toolKind } from './flow.ts';

test('React Flow measurement and selection notifications do not create state updates', () => {
  const positions = { a: { x: 10, y: 20 } };
  assert.equal(updatePositions(positions, []), positions);
  assert.equal(updatePositions(positions, [
    { type: 'dimensions', id: 'a', dimensions: { width: 248, height: 130 } },
    { type: 'select', id: 'a', selected: true },
    { type: 'position', id: 'a', position: { x: 10, y: 20 } },
  ]), positions);
  assert.deepEqual(updatePositions(positions, [
    { type: 'position', id: 'a', position: { x: 30, y: 40 } },
  ]), { a: { x: 30, y: 40 } });
  assert.deepEqual(positions, { a: { x: 10, y: 20 } });
});

test('DAG edges retain all visible parents and pulse only for live work', () => {
  const nodes = [
    { id: 'a', status: 'success' }, { id: 'b', status: 'success' },
    { id: 'c', parents: ['a', 'b', 'missing'], status: 'running' },
    { id: 'd', parents: ['c'], status: 'failed' },
  ];
  const edges = graphEdges(nodes);
  assert.deepEqual(edges.map(({source, target, animated}) => ({source, target, animated})), [
    { source: 'a', target: 'c', animated: true },
    { source: 'b', target: 'c', animated: true },
    { source: 'c', target: 'd', animated: false },
  ]);
  assert.equal(new Set(edges.map(edge => edge.id)).size, 3);
  assert.deepEqual(graphEdges([]), []);
});

test('tool cards distinguish shell, AST maps and custom plugins', () => {
  for (const [name, expected] of [
    ['Bash', 'BASH'], ['PowerShell', 'POWERSHELL'], ['repo_map', 'AST MAP'],
    ['RepoMap', 'AST MAP'], ['company.lookup', 'CUSTOM PLUGIN'],
  ]) assert.equal(toolKind(name), expected);
});
