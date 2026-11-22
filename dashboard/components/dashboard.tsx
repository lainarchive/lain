"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import * as Dialog from "@radix-ui/react-dialog";
import * as Switch from "@radix-ui/react-switch";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  Bot,
  BrainCircuit,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleHelp,
  Command,
  Cpu,
  Database,
  FileCode2,
  GitBranch,
  Layers3,
  Maximize2,
  MemoryStick,
  Network,
  Pause,
  Play,
  Plug,
  Radio,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Terminal,
  Workflow,
  X,
  Zap,
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
  intent: "INPUT",
  reasoning: "INFERENCE",
  tool: "TOOL CALL",
  subagent: "SUB-AGENT",
  reflection: "HERMES",
  output: "OUTPUT",
  error: "ERROR",
};
type FlowNode = Node<TraceNode & Record<string, unknown>, "trace">;

function TraceCard({ data, selected }: NodeProps<FlowNode>) {
  const tool = data.kind === "tool" ? toolKind(data.label) : null;
  const Icon = tool === "AST MAP" ? FileCode2 : tool === "CUSTOM PLUGIN" ? Plug : icons[data.kind];
  return (
    <div
      className={`trace-card ${data.status} ${selected ? "selected" : ""}`}
      title={data.status === "failed" ? data.detail : undefined}
    >
      <Handle type="target" position={Position.Left} />
      <div className="node-eyebrow">
        <span>
          <Icon size={12} />
          {tool ?? labels[data.kind]}
        </span>
        <span className={`status-dot ${data.status}`} />
      </div>
      <strong>{data.label}</strong>
      <p>{data.detail}</p>
      <footer>
        <span className={`node-state ${data.status}`}>
          {data.status === "pending"
            ? "PENDING · APPROVAL"
            : data.status.toUpperCase()}
        </span>
        <span>
          {data.duration !== undefined
            ? `${data.duration.toLocaleString()} ms`
            : data.status === "running"
              ? "in progress"
              : "—"}
          <ChevronRight size={11} />
        </span>
      </footer>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
const nodeTypes = { trace: TraceCard };
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
const compact = (value: number) =>
  value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: "no-store", ...init });
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
  const percent = session
    ? Math.min(
        100,
        Math.round(
          (session.prompt_tokens / Math.max(1, session.context_window)) * 100,
        ),
      )
    : 0;
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

  return (
    <div className="app-shell">
      <aside className="icon-rail">
        <Link className="brand-mark" href="/" aria-label="Lain home">
          l<span>·</span>
        </Link>
        <button
          className={tab === "graph" ? "rail-active" : ""}
          onClick={() => setTab("graph")}
          title="Execution graph"
        >
          <Workflow size={20} />
        </button>
        <button
          className={tab === "memory" ? "rail-active" : ""}
          onClick={() => setTab("memory")}
          title="Memory"
        >
          <Database size={20} />
        </button>
        <button
          className={tab === "plugins" ? "rail-active" : ""}
          onClick={() => setTab("plugins")}
          title="Tools & plugins"
        >
          <Plug size={20} />
        </button>
        <div className="rail-bottom">
          <button
            title="Inspect bridge status"
            onClick={() => {
              setTab("bridge");
            }}
          >
            <Settings2 size={19} />
          </button>
          <button title="Open setup help" onClick={() => setTab("help")}>
            <CircleHelp size={19} />
          </button>
          <span className="avatar">L</span>
        </div>
      </aside>
      <aside className="workspace-sidebar">
        <div className="workspace-title">
          <div className="workspace-icon">
            <Network size={17} />
          </div>
          <div>
            <strong>Lain workspace</strong>
            <small>LOCAL ENVIRONMENT</small>
          </div>
          <ChevronDown size={14} />
        </div>
        <div className="sidebar-section-label">
          WORKSPACE <span>01</span>
        </div>
        <button
          className={`sidebar-link ${tab === "graph" ? "active" : ""}`}
          onClick={() => setTab("graph")}
        >
          <GitBranch size={16} /> Neural graph <span>{graph.nodes.length}</span>
        </button>
        <button
          className={`sidebar-link ${tab === "memory" ? "active" : ""}`}
          onClick={() => setTab("memory")}
        >
          <MemoryStick size={16} /> Memory bank
        </button>
        <button
          className={`sidebar-link ${tab === "plugins" ? "active" : ""}`}
          onClick={() => setTab("plugins")}
        >
          <Layers3 size={16} /> Tool registry{" "}
          <span>{activePlugins.length}</span>
        </button>
        <div className="sidebar-section-label sessions-label">
          SESSIONS <Radio size={12} />
        </div>
        <div className="session-list">
          {activeStatus.sessions.length ? (
            activeStatus.sessions.map((item) => (
              <button
                key={item.session_id}
                className={`session-item ${session?.session_id === item.session_id ? "current" : ""}`}
                onClick={() => {
                  setSessionId(item.session_id);
                  setFitKey((k) => k + 1);
                }}
              >
                <span
                  className={`status-dot ${item.status === "running" ? "running" : item.status === "approval_required" ? "pending" : "success"}`}
                />
                <div>
                  <strong>
                    {item.session_id
                      .replace(/^agent-/, "session-")
                      .slice(0, 19)}
                  </strong>
                  <small>{item.status.replaceAll("_", " ")}</small>
                </div>
              </button>
            ))
          ) : (
            <p className="sidebar-empty">
              No sessions yet.
              <br />
              Start a turn with <code>lain query</code>.
            </p>
          )}
        </div>
        <div className="sidebar-spacer" />
        <div className="local-card">
          <div>
            <span
              className={`status-dot ${connection === "connected" && !demo ? "success" : "pending"}`}
            />
            <strong>
              {demo ? "Example environment" : "Local-first. Always."}
            </strong>
          </div>
          <p>
            {demo
              ? "Simulated trace. Controls are disabled."
              : "Your models. Your machine.\nNothing leaves without permission."}
          </p>
          <span>
            <ShieldCheck size={12} /> POLICY-GOVERNED EXECUTION
          </span>
        </div>
        <div className="sidebar-version">
          <span>LAIN CORE</span>
          <span>
            v0.1.0 <span className="tiny-dot" />
          </span>
        </div>
      </aside>

      <main className="main-workspace">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace <ChevronRight size={13} />
            <span>Neural dashboard</span>
          </div>
          <div className="topbar-actions">
            <span
              className={`connection-pill ${demo ? "example" : connection}`}
            >
              <span className="status-dot" />
              {demo
                ? "EXAMPLE TRACE"
                : connection === "connected"
                  ? "DAEMON CONNECTED"
                  : connection.toUpperCase()}
            </span>
            <span className="local-label">
              <Cpu size={13} /> 127.0.0.1:4040
            </span>
            <button
              className="icon-button"
              onClick={exportTrace}
              title="Export trace"
            >
              <ArrowDownToLine size={16} />
            </button>
          </div>
        </header>
        <section className="page-heading">
          <div>
            <div className="eyebrow">
              <span className="tiny-dot" /> OBSERVABILITY / LIVE EXECUTION
            </div>
            <h1>
              Inside the machine<span>.</span>
            </h1>
            <p>A live window into thought, tools, and everything in between.</p>
          </div>
          <button
            className={`secondary-button ${demo ? "demo-selected" : ""}`}
            onClick={toggleDemo}
          >
            <Play size={13} />
            {demo ? "Return to live" : "Explore example"}
          </button>
        </section>

        <section className="metrics-grid">
          <div className="metric">
            <div className="metric-label">
              <Cpu size={14} /> ACTIVE MODEL <span>LOCAL</span>
            </div>
            <strong className="model-value">
              {session?.model ?? "Awaiting session"}
            </strong>
            <small>
              <span
                className={`status-dot ${session ? "success" : "pending"}`}
              />{" "}
              {session
                ? `${session.turns} inference turns`
                : "No model calls made"}
            </small>
          </div>
          <div className="metric">
            <div className="metric-label">
              <Zap size={14} /> TOKEN BURN <span>SESSION</span>
            </div>
            <strong>
              {compact(session?.tokens_used ?? 0)}
              <em>
                /{" "}
                {session?.token_limit
                  ? compact(session.token_limit)
                  : "uncapped"}
              </em>
            </strong>
            <div className="mini-progress">
              <i
                style={{
                  width: `${session?.token_limit ? Math.min(100, (session.tokens_used / session.token_limit) * 100) : 0}%`,
                }}
              />
            </div>
            <small>Provider-reported total usage</small>
          </div>
          <div className="metric context-metric">
            <div>
              <div className="metric-label">
                <Database size={14} /> CONTEXT WINDOW
              </div>
              <strong>
                {compact(session?.prompt_tokens ?? 0)}
                <em>/ {compact(session?.context_window ?? 0)}</em>
              </strong>
              <small>Estimated prompt occupancy</small>
            </div>
            <div
              className="radial-gauge"
              style={{
                background: `conic-gradient(#6de0c5 ${percent}%, #222728 0)`,
              }}
            >
              <span>
                {percent}
                <small>%</small>
              </span>
            </div>
          </div>
          <div className="metric">
            <div className="metric-label">
              <Activity size={14} /> EXECUTION STATE
            </div>
            <strong className="state-value">
              <span
                className={`status-dot ${session?.control.pending_call ? "pending" : "running"}`}
              />
              {session?.status.replaceAll("_", " ") ?? "Standby"}
            </strong>
            <small>
              {visible.filter((n) => n.status === "success").length} completed{" "}
              <span className="metric-separator">/</span>{" "}
              {visible.filter((n) => n.status === "failed").length} failed nodes
            </small>
          </div>
        </section>

        {(error || graph.gap) && (
          <div className="notice" role="alert">
            {error ??
              "Some events are outside the replay window. This graph may be incomplete."}
            <button
              onClick={() => {
                setError(null);
                setGraph((g) => ({ ...g, gap: false }));
              }}
              aria-label="Dismiss notice"
            >
              <X size={14} />
            </button>
          </div>
        )}

        <section className="execution-panel">
          <div className="panel-tabs">
            <div className="tab-group">
              {[
                ["graph", "Execution graph", Workflow],
                ["memory", "Memory", Database],
                ["plugins", "Tools & plugins", Plug],
              ].map(([id, label, Icon]) => {
                const TabIcon = Icon as typeof Workflow;
                return (
                  <button
                    key={String(id)}
                    className={tab === id ? "tab-active" : ""}
                    onClick={() => setTab(String(id))}
                  >
                    <TabIcon size={14} />
                    {String(label)}
                    {id === "graph" && <span>{visible.length}</span>}
                  </button>
                );
              })}
            </div>
            <div className="panel-session">
              <span className="tiny-dot" />
              {session?.session_id.slice(-14) ?? "NO ACTIVE SESSION"}
            </div>
          </div>

          {tab === "graph" ? (
            <>
              <div className="graph-toolbar">
                <div className="graph-toolbar-left">
                  <label className="search">
                    <Search size={14} />
                    <input
                      aria-label="Search execution nodes"
                      placeholder="Find a node…"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                    <kbd>/</kbd>
                  </label>
                  <select
                    aria-label="Filter node status"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  >
                    <option value="all">All statuses</option>
                    <option value="running">Running</option>
                    <option value="pending">Pending</option>
                    <option value="success">Success</option>
                    <option value="failed">Failed</option>
                  </select>
                </div>
                <div className="graph-actions">
                  <button
                    title={
                      session?.control.paused
                        ? "Resume agent"
                        : "Pause agent at next safe boundary"
                    }
                    disabled={controlsDisabled}
                    onClick={() =>
                      void intervene({
                        command: session?.control.paused ? "resume" : "pause",
                      })
                    }
                  >
                    {session?.control.paused ? (
                      <Play size={14} />
                    ) : (
                      <Pause size={14} />
                    )}
                  </button>
                  <button
                    disabled={controlsDisabled}
                    title="Cancel active turn"
                    onClick={() => void intervene({ command: "cancel" })}
                  >
                    <Square size={12} />
                  </button>
                  <span className="toolbar-divider" />
                  <button
                    title="Fit graph"
                    onClick={() => setFitKey((k) => k + 1)}
                  >
                    <Maximize2 size={15} />
                  </button>
                </div>
              </div>
              <div className="graph-and-hud">
                <div className="graph-canvas">
                  <div className="canvas-label">
                    <span
                      className={`status-dot ${demo ? "pending" : "running"}`}
                    />
                    {demo ? "EXAMPLE / SIMULATED" : "LIVE DIRECTED GRAPH"}
                    <span>LEFT → RIGHT</span>
                  </div>
                  <ReactFlow
                    key={`${fitKey}:${demo}:${nodes.length ? "data" : "empty"}`}
                    nodes={nodes}
                    edges={edges}
                    nodeTypes={nodeTypes}
                    fitView
                    fitViewOptions={{ padding: 0.22, maxZoom: 0.95 }}
                    onNodesChange={onNodesChange}
                    minZoom={0.12}
                    maxZoom={1.7}
                    nodesConnectable={false}
                    nodesDraggable
                    onNodeClick={(_, node) => {
                      setSelectedId(node.id);
                      setPayloadTab("output");
                    }}
                    onPaneClick={() => setSelectedId(null)}
                    colorMode="dark"
                    proOptions={{ hideAttribution: true }}
                  >
                    <Background
                      variant={BackgroundVariant.Dots}
                      gap={20}
                      size={1}
                      color="#263031"
                    />
                    <Controls showInteractive={false} />
                    <MiniMap
                      nodeColor={(node) =>
                        ({
                          running: "#57cdbb",
                          pending: "#bb9b55",
                          success: "#385e57",
                          failed: "#a04f60",
                        })[String(node.data.status)] ?? "#333"
                      }
                      maskColor="rgba(9,13,14,.72)"
                      pannable
                      zoomable
                    />
                  </ReactFlow>
                  {!visible.length && (
                    <div className="canvas-empty">
                      <div className="empty-orbit">
                        <BrainCircuit size={29} />
                      </div>
                      <h2>
                        {query || filter !== "all"
                          ? "No matching nodes"
                          : "Waiting for a signal"}
                      </h2>
                      <p>
                        {query || filter !== "all"
                          ? "Try another search or status filter."
                          : "Start a local agent turn. Its execution unfolds here, in real time."}
                      </p>
                      {!query && filter === "all" && (
                        <>
                          <code>lain query &quot;Map this repository&quot;</code>
                          <button onClick={toggleDemo}>
                            Or explore an example <ArrowRight size={13} />
                          </button>
                        </>
                      )}
                    </div>
                  )}
                  <div className="canvas-legend">
                    <span>
                      <i className="status-dot pending" />
                      Pending
                    </span>
                    <span>
                      <i className="status-dot running" />
                      Running
                    </span>
                    <span>
                      <i className="status-dot success" />
                      Success
                    </span>
                    <span>
                      <i className="status-dot failed" />
                      Failed
                    </span>
                  </div>
                </div>
                <aside className="hud">
                  <div className="hud-heading">
                    <Terminal size={14} />
                    <strong>Hermes scratchpad</strong>
                    <span>{demo ? "SIMULATED" : "LIVE"}</span>
                  </div>
                  <div className="terminal-tabs">
                    <span className="terminal-active">working_memory</span>
                    <span>.md</span>
                    <span className="tiny-dot" />
                  </div>
                  <pre className="scratchpad">
                    {session?.scratchpad ||
                      "# No working notes yet\n\nHermes will write the active plan\nand compact observations here.\n\nWaiting for UpdateScratchpad…"}
                    <span className="terminal-cursor">▊</span>
                  </pre>
                  <div className="context-breakdown">
                    <div className="hud-subheading">
                      CONTEXT COMPOSITION <span>EST.</span>
                    </div>
                    {[
                      [
                        "Memory + system",
                        session?.memory_tokens ?? 0,
                        "memory",
                      ],
                      ["AST repomap", session?.repo_map_tokens ?? 0, "ast"],
                      ["Tool output", session?.tool_tokens ?? 0, "tools"],
                    ].map(([label, value, color]) => (
                      <div className="breakdown-row" key={label}>
                        <span>
                          <i className={String(color)} />
                          {label}
                        </span>
                        <strong>{compact(Number(value))}</strong>
                      </div>
                    ))}
                    <div className="stacked-bar">
                      {[
                        [session?.memory_tokens ?? 0, "memory"],
                        [session?.repo_map_tokens ?? 0, "ast"],
                        [session?.tool_tokens ?? 0, "tools"],
                      ].map(([value, color]) => (
                        <i
                          key={color}
                          className={String(color)}
                          style={{
                            width: `${Math.min(100, (Number(value) / Math.max(1, session?.prompt_tokens ?? 1)) * 100)}%`,
                          }}
                        />
                      ))}
                    </div>
                  </div>
                  <div className="intercept-card">
                    <div className="intercept-title">
                      <ShieldCheck size={15} />
                      <strong>Intercept mode</strong>
                      <Switch.Root
                        className="switch"
                        checked={session?.control.intercept ?? false}
                        disabled={controlsDisabled}
                        onCheckedChange={(enabled) =>
                          void intervene({ command: "intercept", enabled })
                        }
                        aria-label="Intercept mutating tools"
                      >
                        <Switch.Thumb className="switch-thumb" />
                      </Switch.Root>
                    </div>
                    <p>
                      Review mutating tools before they run. Read-only context
                      stays uninterrupted.
                    </p>
                    {session?.control.pending_call && (
                      <div className="approval-box">
                        <span className="approval-label">
                          <span className="status-dot pending" /> APPROVAL
                          REQUIRED
                        </span>
                        <strong>
                          {graph.nodes.findLast((n) => n.status === "pending")
                            ?.label ?? session.control.pending_call}
                        </strong>
                        <div>
                          <button
                            disabled={controlsDisabled}
                            onClick={() =>
                              void intervene({
                                command: "deny",
                                call_id: session.control.pending_call!,
                              })
                            }
                          >
                            <X size={13} /> Deny
                          </button>
                          <button
                            className="approve-button"
                            disabled={controlsDisabled}
                            onClick={() =>
                              void intervene({
                                command: "approve",
                                call_id: session.control.pending_call!,
                              })
                            }
                          >
                            <Check size={13} /> Approve
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </aside>
              </div>
              <form
                className="steer-bar"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (steering.trim())
                    void intervene({ command: "steer", text: steering });
                }}
              >
                <span>
                  <Command size={15} />
                </span>
                <input
                  aria-label="Steer the agent"
                  placeholder={
                    demo
                      ? "Example trace · return to live to steer your agent"
                      : "Steer the agent without breaking its flow…"
                  }
                  value={steering}
                  onChange={(e) => setSteering(e.target.value)}
                  disabled={controlsDisabled}
                  maxLength={8000}
                />
                <span className="steer-hint">NEXT SAFE TURN</span>
                <button
                  type="submit"
                  disabled={controlsDisabled || !steering.trim()}
                  aria-label="Send steering instruction"
                >
                  <Send size={15} />
                </button>
              </form>
            </>
          ) : tab === "memory" ? (
            <div className="data-view">
              <div className="data-view-heading">
                <Database size={22} />
                <div>
                  <h2>Memory bank</h2>
                  <p>
                    Persistent episodes and learned procedural rules from the
                    daemon.
                  </p>
                </div>
                <span className="tag">
                  {activeMemory.semantic.backend} ·{" "}
                  {activeMemory.semantic.embeddings_available
                    ? "embeddings ready"
                    : "no vector index"}
                </span>
              </div>
              <div className="memory-columns">
                <DataList
                  title="Episodic turns"
                  items={activeMemory.episodic}
                />
                <DataList
                  title="Procedural rules"
                  items={activeMemory.procedural}
                />
              </div>
            </div>
          ) : tab === "plugins" ? (
            <div className="data-view">
              <div className="data-view-heading">
                <Plug size={22} />
                <div>
                  <h2>Tool registry</h2>
                  <p>
                    Loaded session tools, including creator-mode scripts and
                    dynamic plugins.
                  </p>
                </div>
              </div>
              <div className="plugin-grid">
                {activePlugins.map((tool) => (
                  <article
                    className="plugin-card"
                    key={`${tool.session_id}:${tool.name}`}
                  >
                    <FileCode2 size={19} />
                    <h3>{tool.name}</h3>
                    <p>{tool.description}</p>
                    <small>{tool.session_id}</small>
                    <details>
                      <summary>Input schema</summary>
                      <pre>{pretty(tool.parameters)}</pre>
                    </details>
                  </article>
                ))}
              </div>
              {!activePlugins.length && (
                <p className="data-empty">
                  No loaded tools. Start a configured session to inspect its
                  registry.
                </p>
              )}
            </div>
          ) : (
            <div className="data-view setup-view">
              <Network size={30} />
              <h2>
                {tab === "bridge"
                  ? "Your local connection"
                  : "Bring your agent online"}
              </h2>
              <p>
                The dashboard is served by the same Rust daemon that runs your
                agent. No cloud account or API key is needed for the UI.
              </p>
              <ol>
                <li>
                  Build the UI:{" "}
                  <code>cd dashboard && npm ci && npm run build</code>
                </li>
                <li>
                  Start the bridge: <code>cargo run -p lain-cli -- ui</code>
                </li>
                <li>
                  In another terminal: <code>lain query &quot;Your objective&quot;</code>
                </li>
              </ol>
              <p>
                Use http://127.0.0.1:4040. Existing daemons must be restarted
                with <code>--serve-ui</code>. Pause takes effect at the next
                turn/tool boundary; cancel interrupts an in-flight call.
              </p>
              <button className="secondary-button" onClick={toggleDemo}>
                {demo ? "Return to live" : "Explore the example"}
                <ArrowRight size={14} />
              </button>
            </div>
          )}
        </section>
        <section className="event-strip">
          <span>
            <Terminal size={13} /> EVENT STREAM
          </span>
          <p>
            {demo
              ? "Example trace loaded · no commands are executed"
              : events.length
                ? `${events.at(-1)?.event.type.replaceAll("_", ".")}  /  sequence ${events.at(-1)?.sequence}`
                : "Listening for daemon events…"}
          </p>
          <span className="event-count">
            {graph.cursor ? `#${String(graph.cursor).padStart(5, "0")}` : "—"}
          </span>
        </section>
        <footer className="page-footer">
          <span>
            <ShieldCheck size={12} /> LOCAL-FIRST <i /> ZERO CLOUD DEPENDENCIES
          </span>
          <span>Built to see. Designed to stay in control.</span>
          <span>
            <Circle size={8} /> ALL SYSTEMS{" "}
            {demo
              ? "SIMULATED"
              : connection === "connected"
                ? "LOCAL"
                : "STANDBY"}
          </span>
        </footer>
      </main>

      <Dialog.Root
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="drawer-overlay" />
          <Dialog.Content className="node-drawer">
            <div className="drawer-header">
              <span className="eyebrow">NODE INSPECTOR</span>
              <Dialog.Close
                className="icon-button"
                aria-label="Close node inspector"
              >
                <X size={18} />
              </Dialog.Close>
            </div>
            <Dialog.Title>{selected?.label}</Dialog.Title>
            <Dialog.Description>
              {selected?.detail}
            </Dialog.Description>
            <div className="drawer-facts">
              <span className={`node-state ${selected?.status}`}>
                {selected?.status}
              </span>
              <span>
                {selected?.duration !== undefined
                  ? `${selected.duration.toLocaleString()} ms`
                  : selected?.status === "running" || selected?.status === "pending" ? "In progress" : "Not recorded"}
              </span>
              <span>{selected?.kind}</span>
            </div>
            <div className="drawer-tabs">
              {["input", "output", "diff"].map((item) => (
                <button
                  className={payloadTab === item ? "active" : ""}
                  key={item}
                  onClick={() => setPayloadTab(item)}
                >
                  {item}
                </button>
              ))}
            </div>
            {payloadTab === "diff" ? (
              selectedDiff ? (
                <pre className="payload diff">
                  {selectedDiff.split("\n").map((line, i) => (
                    <span
                      className={
                        line.startsWith("+")
                          ? "addition"
                          : line.startsWith("-")
                            ? "deletion"
                            : ""
                      }
                      key={i}
                    >
                      {line}
                      {"\n"}
                    </span>
                  ))}
                </pre>
              ) : (
                <p className="data-empty">
                  This node did not produce a diff payload.
                </p>
              )
            ) : (
              <pre className="payload">
                {pretty(
                  payloadTab === "input" ? selected?.input : selected?.output,
                )}
              </pre>
            )}
            {payloadTab === "output" && selected?.result !== undefined && (
              <>
                <h3>Execution result</h3>
                <pre className="payload">{pretty(selected.result)}</pre>
              </>
            )}
            <div className="drawer-bottom">
              <span>SESSION</span>
              <code>{selected?.session}</code>
              <span>NODE ID</span>
              <code>{selected?.id}</code>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

function DataList({ title, items }: { title: string; items: string[] }) {
  return (
    <section className="memory-list">
      <h3>
        {title}
        <span>{items.length}</span>
      </h3>
      {items.length ? (
        items.map((item, i) => (
          <article key={`${i}:${item}`}>
            <span>{String(i + 1).padStart(2, "0")}</span>
            <p>{item}</p>
          </article>
        ))
      ) : (
        <p className="data-empty">Nothing stored yet.</p>
      )}
    </section>
  );
}
