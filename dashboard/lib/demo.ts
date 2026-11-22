import type {
  AgentEvent,
  EventEnvelope,
  MemoryResponse,
  PluginInfo,
  StatusResponse,
} from "./contracts";
import { applyEvent, emptyGraph } from "./graph.ts";

export function exampleRun() {
  const events: AgentEvent[] = [
    {
      type: "intent_received",
      text: "Map the auth module, inspect the failing session test, and propose a minimal fix.",
    },
    { type: "turn_started", session_id: "example-session", turn: 1 },
    {
      type: "thinking",
      turn: 1,
      text: "First map the repository. Then inspect the session boundary and run its focused regression test.",
    },
    {
      type: "tool_invoked",
      turn: 1,
      call_id: "map",
      name: "RepoMap",
      arguments: { path: "src/auth" },
    },
    {
      type: "tool_completed",
      turn: 1,
      call_id: "map",
      name: "RepoMap",
      outcome: {
        outcome: "succeeded",
        content:
          "src/auth/session.rs\n  pub fn validate_session(token: &str) -> Result<Session>\nsrc/auth/refresh.rs\n  pub fn rotate(refresh: &Token) -> Token",
        exit_code: 0,
      },
    },
    {
      type: "tool_invoked",
      turn: 1,
      call_id: "read",
      name: "MemoryRead",
      arguments: { query: "session token validation" },
    },
    {
      type: "tool_completed",
      turn: 1,
      call_id: "read",
      name: "MemoryRead",
      outcome: {
        outcome: "succeeded",
        content: "Treat empty tokens as invalid before consulting the cache.",
        exit_code: 0,
      },
    },
    {
      type: "tool_invoked", turn: 1, call_id: "delegate", name: "ReviewSubagent",
      arguments: { task: "Review session validation without writing files" },
    },
    {
      type: "tool_completed", turn: 1, call_id: "delegate", name: "ReviewSubagent",
      outcome: { outcome: "succeeded", content: "Empty-token guard is missing before cache lookup.", exit_code: null },
    },
    {
      type: "tool_invoked", turn: 1, call_id: "powershell", name: "PowerShell",
      arguments: { command: "Get-Content src/auth/session.rs" },
    },
    {
      type: "tool_completed", turn: 1, call_id: "powershell", name: "PowerShell",
      outcome: { outcome: "succeeded", content: "pub fn validate_session(token: &str) -> Result<Session> {\n    cache.lookup(token)\n}", exit_code: 0 },
    },
    { type: "turn_completed", turn: 1, tool_calls: 4, tokens_used: 4820 },
    { type: "turn_started", session_id: "example-session", turn: 2 },
    {
      type: "thinking",
      turn: 2,
      text: "The validation path needs an empty-token guard. Verify the focused test before proposing any writes.",
    },
    {
      type: "tool_invoked",
      turn: 2,
      call_id: "test",
      name: "Bash",
      arguments: { command: "cargo test session::rejects_empty_token" },
    },
    {
      type: "tool_completed",
      turn: 2,
      call_id: "test",
      name: "Bash",
      outcome: {
        outcome: "failed",
        code: "EXIT_101",
        message:
          'assertion failed: validate_session("").is_err()\n1 test failed; no files changed.',
      },
    },
    {
      type: "tool_invoked",
      turn: 2,
      call_id: "patch",
      name: "ApplyPatch",
      arguments: {
        diff: "--- a/src/auth/session.rs\n+++ b/src/auth/session.rs\n@@ -12,0 +13,3 @@\n+if token.is_empty() {\n+    return Err(AuthError::InvalidToken);\n+}",
      },
    },
    {
      type: "approval_required",
      turn: 2,
      call_id: "patch",
      name: "ApplyPatch",
      arguments: { path: "src/auth/session.rs" },
    },
    {
      type: "reflection_generated",
      summary: "Session boundary / 2 procedural rules",
      rules: [
        "Reject empty credentials before cache lookup.",
        "Test the smallest failing boundary before changing code.",
      ],
    },
  ];
  const frames: EventEnvelope[] = events.map((event, i) => ({
    event,
    session_id: "example-session",
    sequence: i + 1,
    timestamp_ms: 1780000000000 + i * 376,
  }));
  return frames.reduce(applyEvent, emptyGraph);
}
export const exampleStatus: StatusResponse = {
  protocol_version: 1,
  latest_sequence: 19,
  sessions: [
    {
      session_id: "example-session",
      model: "qwen3 / local",
      status: "approval_required",
      turns: 2,
      tokens_used: 7824,
      token_limit: 32000,
      context_window: 32768,
      prompt_tokens: 12480,
      memory_tokens: 2840,
      repo_map_tokens: 1920,
      tool_tokens: 3680,
      scratchpad:
        "01  Map auth entrypoints                 done\n02  Reproduce empty-token regression     done\n03  Add the smallest boundary guard      waiting\n04  Re-run focused + integration tests   next\n\nObservation: cache lookup precedes input validation.\nDo not write until the operator approves the patch.",
      control: { paused: false, intercept: true, pending_call: "patch" },
    },
  ],
};
export const exampleMemory: MemoryResponse = {
  episodic: [
    "Inspect auth session boundary — empty token accepted by cached session.",
  ],
  procedural: [
    "Reject empty credentials before cache lookup.",
    "Test the smallest failing boundary before changing code.",
  ],
  semantic: { backend: "sqlite_fts5", embeddings_available: false },
};
export const examplePlugins: PluginInfo[] = [
  {
    session_id: "example-session",
    name: "ApplyPatch",
    description:
      "Example mutating tool. This preview never executes a command.",
    parameters: { type: "object" },
  },
];
