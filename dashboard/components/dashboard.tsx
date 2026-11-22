"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Switch from "@radix-ui/react-switch";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import {
  ArrowDownToLine, Bot, BrainCircuit, Check, Command, Database, FileCode2,
  Maximize2, Pause, Play, Plug, Search, Send, Sparkles, Square, Terminal, Workflow, X, Zap,
} from "lucide-react";

import {
  isEnvelope,
  type EventEnvelope,
  type Intervention,
  type Json,
  type MemoryResponse,
  type PluginInfo,
  type StatusResponse,
} from "../lib/contracts";
import {
  applyEvent,
  emptyGraph,
  layoutNodes,
  type TraceNode,
} from "../lib/graph";
import {
  exampleMemory,
  examplePlugins,
  exampleRun,
  exampleStatus,
} from "../lib/demo";
import { refreshBridge } from "../lib/live";
import { authorizedHeaders, dashboardToken, websocketProtocols } from "../lib/auth";
import { graphEdges, toolKind, updatePositions } from "../lib/flow";

const icons = {
  intent: Command,
  reasoning: BrainCircuit,
  tool: Terminal,
  subagent: Bot,
  reflection: Sparkles,
  output: Check,
  error: Zap,
};
const labels = {
  intent: "User intent", reasoning: "Reasoning", tool: "Tool call", subagent: "Sub-agent",
  reflection: "Hermes commit", output: "Output", error: "Error",
};
type FlowNode = Node<TraceNode & Record<string, unknown>, "trace">;
function TraceCard({ data, selected }: NodeProps<FlowNode>) {
  const tool = data.kind === "tool" ? toolKind(data.label) : null;
  const Icon = tool === "AST MAP" ? FileCode2 : tool === "CUSTOM PLUGIN" ? Plug : icons[data.kind];
  const type = tool ? { BASH: "Bash", POWERSHELL: "PowerShell", "AST MAP": "AST map",
    "CUSTOM PLUGIN": "Custom plugin" }[tool] : labels[data.kind];
  return (
    <div className={`trace-card ${data.status} ${selected ? "selected" : ""}`}
      title={data.status === "failed" ? data.detail : undefined}>
      <Handle type="target" position={Position.Left} />
      <div className="node-title"><Icon size={14} /><strong>{data.label}</strong>
        <span className={`status-dot ${data.status}`} aria-label={data.status} /></div>
      <div className="node-meta"><span>{type}</span><span className="mono">
        {data.duration !== undefined ? `${data.duration.toLocaleString()} ms` : data.status}
      </span></div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
const nodeTypes = { trace: TraceCard };
const fitViewOptions = { padding: 0.12, minZoom: 0.85, maxZoom: 1 };
const initialStatus: StatusResponse = {
  protocol_version: 1,
  sessions: [],
  latest_sequence: 0,
};
const initialMemory: MemoryResponse = {
  episodic: [],
  procedural: [],
  semantic: { backend: "sqlite_fts5", embeddings_available: false },
};
const pretty = (value: Json | undefined) =>
  value === undefined
    ? "No payload recorded."
    : typeof value === "string"
      ? value
      : JSON.stringify(value, null, 2);

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: "no-store", ...init, headers: authorizedHeaders(dashboardToken(), init?.headers) });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(error?.message ?? `Bridge returned ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export function Dashboard() {
  const [graph, setGraph] = useState(emptyGraph);
  const [status, setStatus] = useState(initialStatus);
  const [memory, setMemory] = useState(initialMemory);
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [demo, setDemo] = useState(false);
  const [connection, setConnection] = useState("connecting");
  const [sessionId, setSessionId] = useState("");
  const [tab, setTab] = useState("graph");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [payloadTab, setPayloadTab] = useState("output");
  const [steering, setSteering] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fitKey, setFitKey] = useState(0);
  const [events, setEvents] = useState<EventEnvelope[]>([]);
  const [positions, setPositions] = useState<
    Record<string, { x: number; y: number }>
  >({});
  const liveScope = useRef<AbortController | null>(null);
  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => {
    setPositions((previous) => updatePositions(previous, changes));
  }, []);

  const refresh = useCallback(async (signal: AbortSignal) => {
    await refreshBridge(fetchJson, signal, (snapshot) => {
      setStatus(snapshot.status);
      setMemory(snapshot.memory);
      setPlugins(snapshot.plugins);
      setConnection("connected");
    });
  }, []);

  useEffect(() => {
    if (demo) return;
    const scope = new AbortController();
    liveScope.current = scope;
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout>;
    let delay = 500;
    const poll = () => {
      void refresh(scope.signal).catch(() => {
        if (!scope.signal.aborted) setConnection("offline");
      });
    };
    const connect = () => {
      if (scope.signal.aborted) return;
      socket = new WebSocket(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/events`,
        websocketProtocols(dashboardToken()),
      );
      socket.onopen = () => {
        if (scope.signal.aborted) return;
        delay = 500;
        setGraph(emptyGraph);
        setEvents([]);
        setConnection("connected");
        poll();
      };
      socket.onmessage = (message) => {
        if (scope.signal.aborted) return;
        try {
          const frame: unknown = JSON.parse(String(message.data));
          if (!isEnvelope(frame)) throw new Error("Unrecognized bridge event");
          setGraph((previous) => applyEvent(previous, frame));
          setEvents((previous) =>
            previous.some((e) => e.sequence === frame.sequence)
              ? previous
              : [...previous, frame].slice(-60),
          );
        } catch {
          setError("An invalid bridge event was ignored.");
        }
      };
      socket.onclose = () => {
        if (scope.signal.aborted) return;
        setConnection("reconnecting");
        retry = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 10000);
      };
      socket.onerror = () => socket?.close();
    };
    poll();
    connect();
    const interval = setInterval(poll, 1500);
    return () => {
      scope.abort();
      clearTimeout(retry);
      clearInterval(interval);
      socket?.close();
    };
  }, [demo, refresh]);

  const activeStatus = demo ? exampleStatus : status;
  const activeMemory = demo ? exampleMemory : memory;
  const activePlugins = demo ? examplePlugins : plugins;
  const session =
    activeStatus.sessions.find((s) => s.session_id === sessionId) ??
    activeStatus.sessions.at(-1);
  const visible = useMemo(
    () =>
      graph.nodes.filter(
        (node) =>
          (!session || node.session === session.session_id) &&
          (filter === "all" || node.status === filter) &&
          `${node.label} ${node.detail}`
            .toLowerCase()
            .includes(query.toLowerCase()),
      ),
    [graph.nodes, session, filter, query],
  );
  const selected = graph.nodes.find((n) => n.id === selectedId);
  const nodes: FlowNode[] = useMemo(
    () =>
      layoutNodes(visible).map((n) => ({
        id: n.id,
        type: "trace",
        position: positions[n.id] ?? { x: n.x, y: n.y },
        data: { ...n },
        selected: n.id === selectedId,
      })),
    [visible, selectedId, positions],
  );
  const edges = useMemo(() => graphEdges(visible), [visible]);
  const selectedDiff =
    selected?.diff ??
    (selected?.input &&
    typeof selected.input === "object" &&
    !Array.isArray(selected.input) &&
    typeof selected.input.diff === "string"
      ? selected.input.diff
      : undefined);

  const intervene = async (
    command: Omit<Intervention, "session_id"> & {
      text?: string;
      enabled?: boolean;
      call_id?: string;
    },
  ) => {
    if (!session || demo || busy || connection !== "connected") return;
    const signal = liveScope.current?.signal;
    if (!signal || signal.aborted) return;
    setBusy(true);
    setError(null);
    try {
      await fetchJson("/api/v1/intervene", {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...command, session_id: session.session_id }),
      });
      if (signal.aborted) return;
      setSteering("");
      await refresh(signal);
    } catch (cause) {
      if (!signal.aborted) setError(cause instanceof Error ? cause.message : "Intervention failed");
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  };
  const controlsDisabled =
    !session || demo || busy || connection !== "connected";
  const toggleDemo = () => {
    liveScope.current?.abort();
    setBusy(false);
    setDemo(!demo);
    setGraph(demo ? emptyGraph : exampleRun());
    setEvents([]);
    setSelectedId(null);
    setPositions({});
    setError(null);
    setFitKey((k) => k + 1);
  };
  const exportTrace = () => {
    const url = URL.createObjectURL(
      new Blob(
        [
          JSON.stringify(
            { demo, status: activeStatus, graph, events },
            null,
            2,
          ),
        ],
        { type: "application/json" },
      ),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "lain-trace.json";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const parts = [
    { label: "Memory", value: session?.memory_tokens ?? 0, className: "memory" },
    { label: "AST repomap", value: session?.repo_map_tokens ?? 0, className: "ast" },
    { label: "Tool output", value: session?.tool_tokens ?? 0, className: "tools" },
    { label: "Other", value: Math.max(0, (session?.prompt_tokens ?? 0) - (session?.memory_tokens ?? 0)
      - (session?.repo_map_tokens ?? 0) - (session?.tool_tokens ?? 0)), className: "other" },
  ];
  const contextTotal = Math.max(1, parts.reduce((sum, part) => sum + part.value, 0));
  const pending = graph.nodes.findLast((node) => node.session === session?.session_id && node.status === "pending");
  const pendingArgs = pending?.input && typeof pending.input === "object" && !Array.isArray(pending.input)
    ? pending.input : undefined;
  const pendingTarget = pendingArgs?.path ?? pendingArgs?.file_path ?? pendingArgs?.command
    ?? (typeof pendingArgs?.diff === "string" ? pendingArgs.diff.match(/^\+\+\+ (?:b\/)?(.+)$/m)?.[1] : undefined);
  const SelectedIcon = selected ? icons[selected.kind] : Terminal;

  return (
    <div className="app-shell">
      <header className="topbar">
        <span className="wordmark">lain</span>
        <nav className="view-switch" aria-label="Dashboard view">
          {[["graph", "Graph", Workflow], ["memory", "Memory", Database], ["plugins", "Plugins", Plug]].map(([id, label, Icon]) => {
            const ViewIcon = Icon as typeof Workflow;
            return <button key={String(id)} aria-current={tab === id ? "page" : undefined}
              onClick={() => setTab(String(id))}><ViewIcon size={14} />{String(label)}</button>;
          })}
        </nav>
        <select className="session-picker" aria-label="Session" value={session?.session_id ?? ""}
          onChange={(e) => { setSessionId(e.target.value); setFitKey((k) => k + 1); }}>
          {!activeStatus.sessions.length && <option value="">No session</option>}
          {activeStatus.sessions.map((item) => <option key={item.session_id} value={item.session_id}>{item.session_id}</option>)}
        </select>
        <div className="topbar-right">
          <span className="connection"><i className={`status-dot ${!demo && connection === "connected" ? "success" : ""}`} />
            {demo ? "Example · offline" : connection === "connected" ? "Connected" : connection}</span>
          <label className="intercept">Intercept
            <Switch.Root className="switch" checked={session?.control.intercept ?? false} disabled={controlsDisabled}
              onCheckedChange={(enabled) => void intervene({ command: "intercept", enabled })} aria-label="Intercept mutating tools">
              <Switch.Thumb className="switch-thumb" /></Switch.Root>
          </label>
          <div className="mode-switch" aria-label="Data source">
            <button aria-pressed={!demo} onClick={() => { if (demo) toggleDemo(); }}>Live</button>
            <button aria-pressed={demo} onClick={() => { if (!demo) toggleDemo(); }}>Example</button>
          </div>
          <button className="icon-button" onClick={exportTrace} title="Export trace" aria-label="Export trace"><ArrowDownToLine size={15} /></button>
        </div>
      </header>
      <aside className="session-sidebar" aria-label="Sessions">
        <h2>Sessions <span className="mono">{activeStatus.sessions.length}</span></h2>
        <div className="session-list">
          {activeStatus.sessions.map((item) => <button key={item.session_id}
            className={`session-item ${session?.session_id === item.session_id ? "current" : ""}`}
            aria-pressed={session?.session_id === item.session_id}
            onClick={() => { setSessionId(item.session_id); setFitKey((k) => k + 1); }}>
            <span className={`status-dot ${item.status === "running" ? "running" : item.status === "approval_required" ? "pending" : "success"}`} />
            <span><span className="session-id mono">{item.session_id}</span><small>{item.status.replaceAll("_", " ")}</small></span>
          </button>)}
          {!activeStatus.sessions.length && <p className="muted sidebar-empty">No sessions yet.</p>}
        </div>
        <details className="connection-details"><summary>Connection &amp; setup</summary>
          <p>127.0.0.1:4040</p><p>Start the bridge:</p><code>cargo run -p lain-cli -- ui</code>
          <p>Start a run:</p><code>lain query &quot;Your objective&quot;</code>
          <p>Restart existing daemons with <code>--serve-ui</code>. Pause takes effect at the next safe boundary.</p>
          <pre>{JSON.stringify(activeStatus, null, 2)}</pre>
        </details>
      </aside>
      <main className="main-workspace">
        {error && <div className="error-banner" role="alert">{error}<button className="icon-button" aria-label="Dismiss error"
          onClick={() => setError(null)}><X size={14} /></button></div>}
        {graph.gap && <p className="gap-warning" role="status">Some event history is unavailable.</p>}
        {tab === "graph" ? <>
          <div className="graph-toolbar">
            <label className="search"><Search size={14} /><input aria-label="Search execution nodes" placeholder="Find a node"
              value={query} onChange={(e) => setQuery(e.target.value)} /></label>
            <select aria-label="Filter node status" value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="all">All statuses</option><option value="running">Running</option><option value="pending">Pending</option>
              <option value="success">Success</option><option value="failed">Failed</option></select>
            <div className="graph-actions">
              <button className="icon-button" aria-label={session?.control.paused ? "Resume agent" : "Pause agent"}
                title={session?.control.paused ? "Resume agent" : "Pause agent at next safe boundary"} disabled={controlsDisabled}
                onClick={() => void intervene({ command: session?.control.paused ? "resume" : "pause" })}>
                {session?.control.paused ? <Play size={14} /> : <Pause size={14} />}</button>
              <button className="icon-button" disabled={controlsDisabled} aria-label="Cancel active turn" title="Cancel active turn"
                onClick={() => void intervene({ command: "cancel" })}><Square size={12} /></button>
              <button className="icon-button" title="Fit graph" aria-label="Fit graph" onClick={() => setFitKey((k) => k + 1)}><Maximize2 size={15} /></button>
            </div>
          </div>
          <div className="graph-canvas">
            <ReactFlow key={`${fitKey}:${demo}:${nodes.length ? "data" : "empty"}`} nodes={nodes} edges={edges} nodeTypes={nodeTypes}
              fitView fitViewOptions={fitViewOptions} onNodesChange={onNodesChange} minZoom={0.12} maxZoom={1.7}
              nodesConnectable={false} nodesDraggable onNodeClick={(_, node) => { setSelectedId(node.id); setPayloadTab("output"); }}
              onPaneClick={() => setSelectedId(null)} colorMode="dark" proOptions={{ hideAttribution: true }}>
              <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#27272a" />
              <Controls showInteractive={false} fitViewOptions={fitViewOptions} />
            </ReactFlow>
            {!visible.length && <div className="canvas-empty"><p>{query || filter !== "all" ? "No matching nodes" : "No active run"}</p>
              {query || filter !== "all" ? <span>Try another search or status filter.</span> : <>
                <code>lain query &quot;…&quot;</code><button className="text-button" onClick={toggleDemo}>Load example</button></>}
            </div>}
            <div className="canvas-legend">{["pending", "running", "success", "failed"].map((state) =>
              <span key={state}><i className={`status-dot ${state}`} />{state[0].toUpperCase() + state.slice(1)}</span>)}</div>
          </div>
          <form className="steer-bar" onSubmit={(e) => { e.preventDefault();
            if (steering.trim()) void intervene({ command: "steer", text: steering }); }}>
            <Command size={14} /><input aria-label="Steer the agent" placeholder={demo ? "Example trace · controls disabled" : "Send an instruction for the next safe turn"}
              value={steering} onChange={(e) => setSteering(e.target.value)} disabled={controlsDisabled} />
            <button className="icon-button" type="submit" disabled={controlsDisabled || !steering.trim()} aria-label="Send steering instruction"><Send size={14} /></button>
          </form>
        </> : tab === "memory" ? <div className="data-view">
          <header className="data-heading"><h1>Memory</h1><span className="muted">Stored context and learned rules</span></header>
          <dl className="semantic-status"><div><dt>Backend</dt><dd>{activeMemory.semantic.backend}</dd></div>
            <div><dt>Embeddings</dt><dd>{activeMemory.semantic.embeddings_available ? "Available" : "Not available"}</dd></div></dl>
          <DataList title="Episodic turns" items={activeMemory.episodic} /><DataList title="Procedural rules" items={activeMemory.procedural} />
        </div> : <div className="data-view">
          <header className="data-heading"><h1>Plugins</h1><span className="muted">Loaded tools and input schemas</span></header>
          {activePlugins.map((tool) => <article className="plugin-row" key={`${tool.session_id}:${tool.name}`}>
            <h2><Plug size={16} />{tool.name}</h2><p>{tool.description}</p><small className="mono muted">{tool.session_id}</small>
            <details><summary>Input schema</summary><pre>{pretty(tool.parameters)}</pre></details>
          </article>)}
          {!activePlugins.length && <p className="muted">No loaded tools.</p>}
        </div>}
        <footer className="event-strip"><span>{demo ? "Example trace · no commands executed" : events.length
          ? events.at(-1)?.event.type.replaceAll("_", " ") : "Listening for events"}</span>
          <span className="mono">{graph.cursor ? `#${String(graph.cursor).padStart(5, "0")}` : "—"}</span></footer>
      </main>
      <aside className="run-sidebar" aria-label="Run details">
        <section className="context-section"><h2>Context</h2><p className="model-name mono">{session?.model ?? "No model selected"}</p>
          <dl className="context-numbers">
            <div><dt>Tokens used</dt><dd>{(session?.tokens_used ?? 0).toLocaleString()} <span>/ {session?.token_limit?.toLocaleString() ?? "Uncapped"}</span></dd></div>
            <div><dt>Prompt</dt><dd>{(session?.prompt_tokens ?? 0).toLocaleString()} <span>/ {(session?.context_window ?? 0).toLocaleString()}</span></dd></div>
          </dl>
          <div className="segmented-bar" aria-label="Prompt context composition">{parts.map((part) =>
            <i key={part.className} className={part.className} style={{ width: `${(part.value / contextTotal) * 100}%` }} />)}</div>
          <div className="context-legend">{parts.map((part) => <div key={part.className}>
            <span><i className={part.className} />{part.label}</span><span className="mono">{part.value.toLocaleString()}</span></div>)}</div>
        </section>
        <section className="approvals-section"><h2>Pending approvals</h2>
          {session?.control.pending_call ? <div className="approval">
            <div className="approval-name"><span className="status-dot pending" /><strong>{pending?.label ?? session.control.pending_call}</strong></div>
            <p className="approval-target-label">Target</p>
            <pre className="approval-target">{typeof pendingTarget === "string" ? pendingTarget : pretty(pending?.input)}</pre>
            <div className="approval-actions">
              <button disabled={controlsDisabled} onClick={() => void intervene({ command: "approve", call_id: session.control.pending_call! })}><Check size={14} />Approve</button>
              <button disabled={controlsDisabled} onClick={() => void intervene({ command: "deny", call_id: session.control.pending_call! })}><X size={14} />Deny</button>
            </div>{demo && <small className="muted">Example only · controls disabled</small>}
          </div> : <p className="muted">No pending approvals.</p>}
        </section>
        <section className="scratchpad-section"><h2><Terminal size={15} />Scratchpad</h2><pre>{session?.scratchpad || "No working notes yet."}</pre></section>
      </aside>
      <Dialog.Root modal={false} open={!!selected} onOpenChange={(open) => { if (!open) setSelectedId(null); }}>
        <Dialog.Portal>
          <Dialog.Content className="node-drawer" onInteractOutside={(event) => event.preventDefault()}>
            <header className="drawer-heading"><SelectedIcon size={18} /><Dialog.Title>{selected?.label}</Dialog.Title>
              <Dialog.Close className="icon-button" aria-label="Close node inspector"><X size={18} /></Dialog.Close></header>
            <div className="drawer-facts"><span>{selected ? labels[selected.kind] : ""}</span>
              <span className={`node-state ${selected?.status}`}><i className={`status-dot ${selected?.status}`} />{selected?.status}</span>
              <span className="mono">{selected?.duration !== undefined ? `${selected.duration.toLocaleString()} ms`
                : selected?.status === "running" || selected?.status === "pending" ? "In progress" : "Not recorded"}</span></div>
            <Dialog.Description>{selected?.detail}</Dialog.Description>
            <div className="drawer-tabs" role="group" aria-label="Node payload">
              {["input", "output", "diff"].map((item) => <button aria-pressed={payloadTab === item} key={item}
                onClick={() => setPayloadTab(item)}>{item[0].toUpperCase() + item.slice(1)}</button>)}</div>
            <div className="drawer-scroll">
              {payloadTab === "diff" ? selectedDiff ? <pre className="payload diff">{selectedDiff.split("\n").map((line, i) =>
                <span key={i} className={line.startsWith("+") ? "addition" : line.startsWith("-") ? "deletion" : ""}>{line}{"\n"}</span>)}</pre>
                : <p className="muted">No diff recorded.</p> : <pre className="payload">{pretty(payloadTab === "input" ? selected?.input : selected?.output)}</pre>}
              {payloadTab === "output" && selected?.result !== undefined && <><h3>Execution result</h3><pre className="payload">{pretty(selected.result)}</pre></>}
              <dl className="drawer-ids"><dt>Session</dt><dd>{selected?.session}</dd><dt>Node</dt><dd>{selected?.id}</dd></dl>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

function DataList({ title, items }: { title: string; items: string[] }) {
  return <section className="memory-list"><h2>{title}<span className="mono muted">{items.length}</span></h2>
    {items.length ? items.map((item, i) => <article key={`${i}:${item}`}><span className="mono muted">{String(i + 1).padStart(2, "0")}</span>
      <p>{item}</p></article>) : <p className="muted">Nothing stored yet.</p>}</section>;
}
