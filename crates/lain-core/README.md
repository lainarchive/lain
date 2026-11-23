# lain-core

Async provider and tool primitives, not an autonomous runner or a policy layer.
Callers remain responsible for authorization, privacy and spend budgets before
calling a provider or dispatching a tool.

`OpenAiCompatibleProvider::new(base_url, api_key)` accepts the API root including
any version prefix: DeepSeek's `/v1`, Gemini's `/v1beta/openai`, or Ollama's `/v1`.
It appends `/chat/completions`. Keys are optional; configured keys use Bearer auth.
The default request deadline is 120 seconds, including streaming; `with_timeout`
overrides it. Streaming emits text, indexed tool-call argument fragments and
finish reasons. Callers assemble argument fragments before parsing JSON.
Malformed events and premature EOF surface as stream errors, not successful EOF.

`ToolRegistry` snapshots schemas at registration and validates arguments before
execution. `tool_messages` executes calls in order, preserving call IDs, and
turns execution failures into JSON error messages for the model.

`BashTool` runs with host user permissions. It is not OS-sandboxed. Its optional
`timeout_ms` overrides the configured deadline (30 seconds in the CLI), capped at
300 seconds. On timeout it kills and reaps the immediate child, not an entire
descendant process tree.
Each call starts a fresh shell, inherits only allowlisted environment variables
such as PATH, and closes stdin. Each of stdout and stderr retains at most `output_byte_cap`
bytes, plus a truncation marker when needed. Both pipes are drained concurrently
without retaining unlimited output. Output is decoded lossily as UTF-8.

`MemoryReadTool` requires a nonempty query and accepts a limit of 1–100 (default
10). `MemoryStore` exposes FTS search, not a recent-record listing API, so I use
its trusted, non-superseded search ranked by relevance and then update time
rather than bypassing the store with SQL. SQLite work runs on a blocking worker;
the standard mutex never spans an await.

Tests use loopback mock HTTP/SSE servers and temporary stores only; no external
model requests, API credentials or paid services are needed.
