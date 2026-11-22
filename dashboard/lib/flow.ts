import type { NodeChange } from "@xyflow/react";
import type { TraceNode } from "./graph.ts";

type Positions = Record<string, { x: number; y: number }>;

export function updatePositions(previous: Positions, changes: NodeChange[]): Positions {
  let next = previous;
  for (const change of changes) {
    if (change.type !== "position" || !change.position) continue;
    const old = next[change.id];
    if (old?.x === change.position.x && old?.y === change.position.y) continue;
    if (next === previous) next = { ...previous };
    next[change.id] = change.position;
  }
  return next;
}

export function graphEdges(nodes: TraceNode[]) {
  const ids = new Set(nodes.map((node) => node.id));
  return nodes.flatMap((node) => (node.parents ?? [])
    .filter((id) => ids.has(id))
    .map((parent) => ({
      id: `edge:${parent}:${node.id}`,
      source: parent,
      target: node.id,
      animated: node.status === "running" || node.status === "pending",
      className: node.status,
      style: {
        stroke: node.status === "failed" ? "#e11d48"
          : node.status === "running" ? "#22d3ee"
          : node.status === "pending" ? "#a88a48" : "#10b981",
        strokeWidth: 1.5,
      },
    })));
}

export function toolKind(name: string) {
  if (/^bash$/i.test(name)) return "BASH";
  if (/^powershell$/i.test(name)) return "POWERSHELL";
  if (/^(repo_?map|ast_?map)$/i.test(name)) return "AST MAP";
  return "CUSTOM PLUGIN";
}
