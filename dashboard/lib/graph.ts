import type { EventEnvelope, Json } from "./contracts.ts";

export type NodeStatus = "pending" | "running" | "success" | "failed";
export interface TraceNode {
  id: string;
  session: string;
  kind:
    | "intent"
    | "reasoning"
    | "tool"
    | "subagent"
    | "reflection"
    | "output"
    | "error";
  label: string;
  detail: string;
  status: NodeStatus;
  started: number;
  duration?: number;
  input?: Json;
  output?: Json;
  result?: Json;
  diff?: string;
  turn?: number;
  parents?: string[];
}
export interface TraceGraph {
  nodes: TraceNode[];
  cursor: number;
  gap: boolean;
}
export const emptyGraph: TraceGraph = { nodes: [], cursor: 0, gap: false };

export function applyEvent(
  previous: TraceGraph,
  frame: EventEnvelope,
): TraceGraph {
  if (frame.sequence <= previous.cursor) return previous;
  const { event, session_id: session, timestamp_ms: time, sequence } = frame;
  const nodes = previous.nodes.map((n) => ({ ...n }));
  const latest = () => nodes.findLast((n) => n.session === session);
  const tail = () => latest() ? [latest()!.id] : [];
  const reasoning =
    "turn" in event
      ? nodes.find((n) => n.id === `${session}:turn:${event.turn}`)
      : undefined;
  const add = (node: Omit<TraceNode, "session" | "started">) =>
    nodes.push({ session, started: time, ...node });
  const finish = (
    node: TraceNode | undefined,
    output?: Json,
    status: NodeStatus = "success",
  ) => {
    if (node) {
      node.status = status;
      if (output !== undefined) node.output = output;
      node.duration = Math.max(0, time - node.started);
    }
  };
  switch (event.type) {
    case "intent_received":
      add({
        id: `${session}:intent:${sequence}`,
        kind: "intent",
        label: "User intent",
        detail: event.text,
        status: "success",
        input: event.text,
      });
      break;
    case "turn_started": {
      const parents = nodes.filter((n) => n.session === session
        && (n.kind === "tool" || n.kind === "subagent") && n.turn === event.turn - 1).map((n) => n.id);
      add({
        id: `${session}:turn:${event.turn}`,
        kind: "reasoning",
        label: `Reasoning / ${String(event.turn).padStart(2, "0")}`,
        detail: "Building the next move",
        status: "running",
        turn: event.turn,
        parents: parents.length ? parents : tail(),
      });
      break;
    }
    case "thinking_token":
      if (reasoning) {
        reasoning.detail = "Receiving model output";
        reasoning.output = `${reasoning.output ?? ""}${event.text}`;
      }
      break;
    case "thinking":
      if (reasoning) {
        reasoning.detail = event.text;
        reasoning.output = event.text;
      }
      break;
    case "tool_invoked":
      add({
        id: `${session}:tool:${event.turn}:${event.call_id}`,
        kind: /agent/i.test(event.name) ? "subagent" : "tool",
        label: event.name,
        detail: "Executing tool",
        status: "running",
        input: event.arguments,
        parents: reasoning ? [reasoning.id] : tail(),
        turn: event.turn,
      });
      break;
    case "approval_required": {
      const tool = nodes.find(
        (n) => n.id === `${session}:tool:${event.turn}:${event.call_id}`,
      );
      if (tool) {
        tool.status = "pending";
        tool.detail = "Awaiting your approval";
      }
      break;
    }
    case "tool_completed": {
      const tool = nodes.find(
        (n) => n.id === `${session}:tool:${event.turn}:${event.call_id}`,
      );
      const outcome = event.outcome;
      const ok =
        outcome.outcome === "succeeded" &&
        (outcome.exit_code === null || outcome.exit_code === 0);
      const output =
        outcome.outcome === "succeeded"
          ? outcome.content
          : outcome.outcome === "failed"
            ? outcome.message
            : outcome.reason;
      finish(tool, output, ok ? "success" : "failed");
      if (tool) {
        tool.result = outcome;
        tool.detail = ok ? "Execution complete" : output;
        if (/^(@@|diff --git|--- )/m.test(output)) tool.diff = output;
      }
      break;
    }
    case "output_generated":
      finish(reasoning);
      add({
        id: `${session}:output:${sequence}`,
        kind: "output",
        label: "Agent response",
        detail: event.text,
        status: "success",
        output: event.text,
        parents: reasoning ? [reasoning.id] : tail(),
      });
      break;
    case "turn_completed":
      finish(reasoning, reasoning?.output);
      break;
    case "reflection_generated":
      add({
        id: `${session}:reflection:${sequence}`,
        kind: "reflection",
        label: "Hermes commit",
        detail: event.summary,
        status: "success",
        output: { summary: event.summary, rules: event.rules },
        parents: tail(),
      });
      break;
    case "error_tripped":
    case "reflection_failed":
      add({
        id: `${session}:error:${sequence}`,
        kind: "error",
        label: event.code,
        detail: "message" in event ? event.message : "Reflection failed",
        status: "failed",
        output: "message" in event ? event.message : event.code,
        parents: tail(),
      });
      break;
    case "terminated":
      nodes
        .filter(
          (n) =>
            n.session === session &&
            (n.status === "running" || n.status === "pending"),
        )
        .forEach((n) => {
          finish(n, undefined, "failed");
          n.detail = `Terminated: ${event.reason.reason}`;
          n.result = event.reason;
        });
      break;
    case "session_completed":
      nodes
        .filter((n) => n.session === session && n.status === "running")
        .forEach((n) => finish(n, n.output));
      break;
    case "scratchpad_updated":
    case "context_measured":
      break;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
  return {
    nodes: nodes.slice(-180),
    cursor: sequence,
    gap:
      previous.gap || sequence > previous.cursor + 1,
  };
}

export function layoutNodes(nodes: TraceNode[]) {
  const levels = new Map<string, number>();
  const rows = new Map<number, number>();
  return nodes.map((node) => {
    const level = Math.max(0, ...(node.parents ?? []).map((id) => (levels.get(id) ?? -1) + 1));
    levels.set(node.id, level);
    const row = rows.get(level) ?? 0;
    rows.set(level, row + 1);
    return { ...node, x: 80 + level * 244, y: 100 + row * 88 };
  });
}
