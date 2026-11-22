import type { EventEnvelope, MemoryResponse, PluginInfo, StatusResponse } from "./generated.ts";
import { applyEvent, emptyGraph, type TraceGraph } from "./graph.ts";

export type BridgeResources = {
  "/api/v1/status": StatusResponse;
  "/api/v1/memory": MemoryResponse;
  "/api/v1/plugins": PluginInfo[];
  "/ws/events": { graph: TraceGraph; events: EventEnvelope[] };
};

export function createBridgeCache() {
  let resources: BridgeResources = {
    "/api/v1/status": { protocol_version: 1, sessions: [], latest_sequence: 0 },
    "/api/v1/memory": { episodic: [], procedural: [], semantic: { backend: "sqlite_fts5", embeddings_available: false } },
    "/api/v1/plugins": [],
    "/ws/events": { graph: emptyGraph, events: [] },
  };
  const listeners = new Map<keyof BridgeResources, Set<() => void>>();
  return {
    get<K extends keyof BridgeResources>(key: K): BridgeResources[K] { return resources[key]; },
    set<K extends keyof BridgeResources>(key: K, value: BridgeResources[K]) {
      if (Object.is(resources[key], value)) return;
      resources = { ...resources, [key]: value };
      listeners.get(key)?.forEach((listener) => listener());
    },
    subscribe(key: keyof BridgeResources, listener: () => void) {
      const subscribers = listeners.get(key) ?? new Set();
      listeners.set(key, subscribers);
      subscribers.add(listener);
      return () => { subscribers.delete(listener); };
    },
  };
}

export type BridgeCache = ReturnType<typeof createBridgeCache>;

export function applyBridgeEvent(cache: BridgeCache, frame: EventEnvelope) {
  const trace = cache.get("/ws/events");
  if (frame.sequence <= trace.graph.cursor) return;
  cache.set("/ws/events", { graph: applyEvent(trace.graph, frame), events: [...trace.events, frame].slice(-60) });
  const status = cache.get("/api/v1/status");
  cache.set("/api/v1/status", {
    ...status,
    latest_sequence: Math.max(status.latest_sequence, frame.sequence),
    sessions: status.sessions.map((session) => {
      if (session.session_id !== frame.session_id) return session;
      const next = { ...session, control: { ...session.control } };
      const event = frame.event;
      switch (event.type) {
        case "intent_received": next.status = "running"; break;
        case "turn_started": next.turns = event.turn; break;
        case "turn_completed": next.tokens_used = event.tokens_used; break;
        case "context_measured":
          next.prompt_tokens = event.prompt_tokens;
          next.memory_tokens = event.memory_tokens;
          next.repo_map_tokens = event.repo_map_tokens;
          next.tool_tokens = event.tool_tokens;
          break;
        case "scratchpad_updated": next.scratchpad = event.plan; break;
        case "approval_required":
          next.status = "approval_required";
          next.control.pending_call = event.call_id;
          break;
        case "tool_completed":
          if (next.control.pending_call === event.call_id) next.control.pending_call = null;
          break;
        case "terminated": next.status = "terminated"; next.control.pending_call = null; break;
        case "session_completed": next.status = event.reason; next.control.pending_call = null; break;
      }
      return next;
    }),
  });
}
