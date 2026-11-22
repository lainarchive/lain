# `lain` Rust CLI

Build with `cargo build -p lain-cli`, then run `target/debug/lain --help`.

```text
lain start
lain query "Summarize the current task"
lain memory inspect --limit 10 --session SESSION_ID
lain ui
lain tui
lain tui demo
lain daemon --endpoint /path/to/lain.sock --config /path/to/lain.json
```

`lain ui` runs the daemon with the browser dashboard enabled. Build the
[dashboard assets](../../dashboard/README.md#run-locally) before starting it.

`start`, `query`, `tui`, and `memory inspect` ping the daemon and spawn the same binary's
internal `daemon` command if needed. Startup retries for about five seconds.
An already-running daemon retains its original working directory and config path;
client-side `--config` only applies when spawning a daemon. Run `daemon` in the
foreground to see startup errors. Ctrl-C stops a foreground daemon gracefully.

Global options are `--endpoint`, `--config`, `--plain`, and `--help`.
Endpoint/config defaults come from `LAIN_IPC_ENDPOINT` / `LAIN_CONFIG`, otherwise
the IPC platform default / `lain.json` in the daemon's working directory.
`LAIN_MEMORY_DB` overrides the default `.lain/memory.db` in that directory.
Windows uses `\\.\pipe\lain-ipc`; Unix uses `$XDG_RUNTIME_DIR/lain-ipc.sock` when set,
otherwise the temporary directory's `lain-ipc-<uid>.sock` (home-directory owner UID,
then `UID` or `USER`; without any identity information, a process-scoped fallback
requires an explicit shared `--endpoint` to connect separate processes).
Do not expose the endpoint to untrusted local users: connected clients can ask
the configured agent to execute host-permission tools. Lain is not a sandbox.

## Terminal frontier

`lain tui` opens the Ratatui lane view. `lain tui demo` renders an **offline synthetic sample**
without a daemon, config, provider call, or credentials. It uses the same renderer and keyboard handling.
The status banner and right-hand scratchpad/rules drawer stay fixed while selection scrolls the lane tree.
Up/Down select layers, nodes and tools; Space folds the selection when the composer is empty.
PgUp/PgDn scroll the lanes, including long answers; changing selection returns to the selected heading.
An expanded selected tool opens its full output in the right drawer; PgUp/PgDn then scroll that output. The lane preview
always shows at most ten lines. The scratchpad and procedural rules remain visible above full output.

Tab cycles **Architect → Code → Ask** while idle. Architect and Ask both allow only the registry's
identity-checked built-in read tools; Code retains the daemon's configured tool permissions. Enable
`coding_session` in the daemon config for AST planning with `repo_map`. The in-memory scratchpad tool
is still allowed in read-only modes; normal transcript/reflection storage is unchanged. Plugins,
creator tools and shell calls are denied before dispatch, even if the model invents an unadvertised call.
This is enforced by the daemon's runner, not by racing cancellation against tool execution. It is not
an OS sandbox or a restriction on other clients' Code requests. A mode change cannot weaken an active turn.

Enter submits a prompt. While running, Enter sends the text using the existing message command
(the read-only variant in Architect/Ask). The daemon currently rejects a mid-turn message with
`SESSION_BUSY`; it neither queues nor applies it as steering. The rejection is displayed without
cancelling the active turn. The dashboard's separate steering API is not used by this IPC client.
Two Escape presses within 500ms send `CancelTurn`, remove the last turn's displayed blocks and restore
its submitted prompt. A lone Escape does not rewind. Late replies from that turn are ignored and the
next submission starts a fresh session. Rewind **does not undo tool side effects or persisted memory**.
`q` or Ctrl-C quits and cancels a running turn; the terminal guard restores raw mode, cursor and screen
on normal and error exits. `q` is reserved, not a composer character.

Live IPC currently describes serial agent turns, not a parallel harness DAG. Each submitted turn becomes
a dependent node rendered through `Dag::layers()`; the demo exercises parallel lanes, repair nodes and
advisor-note colors. No advisor is started and no verification evidence is fabricated: ordinary daemon
completion is `◇ prepared`, not `✓ verified`. Advisor notes can be rendered by the pure model, but the
daemon has no advisor-note event yet.

Telemetry is polled from the daemon's actual session snapshot: configured model, last measured request
context and cumulative provider-reported usage. Velocity is the token-usage delta in a trailing five-second
window, updated at model-step boundaries, not a count of text chunks. Cost stays **unknown** because the
daemon has no configured pricing source; unknown usage/pricing is never displayed as free. Before a
context measurement, the banner reports unknown. The branch comes from Git in the client's cwd; detached
worktrees show `detached@<short-sha>`. An existing daemon may still use another cwd/config as described above.

The additive `send_read_only_message` and `get_telemetry` IPC commands require this daemon version;
an older daemon rejects them rather than silently falling back to unrestricted execution.

To save a 140×45 TestBackend text rendering:
`LAIN_TUI_DUMP=/absolute/path/tui-sample.txt cargo test -p lain-cli tui::tests::sample_dump`.

## Configuration

No config is required for daemon health or memory inspection. Creating a session
without config returns `CONFIG_NOT_FOUND`; it does not stop the daemon. No network
provider is contacted until a configured session receives a message. This example
explicitly selects a local OpenAI-compatible server; it does not start that server
or download a model:

```json
{
  "provider": {
    "kind": "open_ai_compatible",
    "base_url": "http://127.0.0.1:11434/v1",
    "api_key_env": null
  },
  "model": "your-already-installed-model",
  "system_prompt": "Work locally and verify results before answering.",
  "temperature": null,
  "max_turns": 8,
  "max_consecutive_tool_errors": 3,
  "memory_context_limit": 5,
  "tool_call_mode": "native",
  "coding_session": false,
  "context_window_tokens": 16384,
  "budget": {
    "max_total_tokens": null,
    "max_completion_tokens": null,
    "max_tool_calls": 8,
    "max_wall_time_ms": 120000
  }
}
```

Remote or paid providers require an explicit config choice; this CLI supplies no
provider or credential defaults. Keep keys in the environment variable named by
`api_key_env`, not in JSON. Tools are Bash on Unix or PowerShell on Windows, plus
trusted-memory search; the runner also provides its scratchpad tool.

Shell tools are **disabled by default**. Set `LAIN_ALLOW_SHELL=1` in the daemon's environment to explicitly
authorize Bash (Unix) or PowerShell (Windows). Other values do not grant access.
An already-running daemon must be restarted to change this authorization.

### Dynamic plugins and Creator Mode

On each new session the daemon discovers JSON and YAML manifests in
`.lain/plugins/` and `.lain/tools/` in its working directory. Plugin discovery
is off unless the operator grants `read_fs` in `plugin_permissions` in the main
config. Each manifest declares `name`, `version`, `author`, `permissions`, and
`tools`. The daemon rejects invalid manifests, missing grants, and duplicate
tool names. For example, a webhook manifest can be written as:

```yaml
name: inventory
version: 1.0.0
author: Local operator
permissions: [network]
tools:
  - name: lookup_inventory
    description: Look up one item by SKU
    parameters:
      type: object
      properties:
        sku: {type: string}
      required: [sku]
    backend:
      kind: webhook
      url: http://127.0.0.1:8090/lookup
```

This example requires `"plugin_permissions": ["read_fs", "network"]`. The
webhook receives a JSON POST; redirects are not followed. A `cli` backend takes
an absolute `program` and optional fixed `args`. It receives the tool's JSON
arguments on stdin and returns stdout and stderr. A `script` backend takes an
`interpreter` (`python`, `powershell`, or `node`) and a standalone script
`path` relative to the manifest directory. It reads a single JSON-RPC 2.0
request from stdin to EOF. The method is the export name, `params` is the tool
arguments, and stdout must contain one JSON-RPC response with the same ID and
either `result` or `error`. Send diagnostics to stderr.

Script and CLI processes run with host user permissions, **not in a sandbox**.
They require all four capabilities in both the manifest and the operator's
`plugin_permissions`: `read_fs`, `write_fs`, `network`, and `subprocess`.
Grant these only in a trusted workspace for a trusted agent. This is separate
from `LAIN_ALLOW_SHELL`; neither setting grants the other.

`allow_creator_mode` defaults to true in debug builds and false in release
builds. Set it to false explicitly for strict operation, and keep
`plugin_permissions` empty to prevent loading plugins. Creator Mode requires
the same explicit four grants as script plugins. [ADR-012](../../DECISIONS.md#adr-012-extension-creation-differs-from-activation)
allows dev-mode testing and registration without per-candidate approval.
`test_tool` runs a proposed script without saving it. `create_tool` validates the argument schema, runs with
the supplied `test_args`, and on success writes the script and manifest to
`.lain/tools/` and registers the tool in the active session. It becomes
available to the model on its next request and to new sessions on discovery.
On failure the agent receives diagnostics rather than a registered tool.

Set `coding_session: true` to attach a compact Rust/TypeScript outline to the
first model prompt and enable `repo_map` to request a fresh scan. The tool takes no
path argument; the workspace is the daemon's original working directory. The
scan resolves paths relative to an opened workspace directory and skips hidden
paths, symlinks, Windows reparse points, and common build/vendor directories. It
does not interpret `.gitignore`. Enable this only if the configured provider may receive
that workspace's file names, signatures, and doc summaries. The outline is
untrusted source data, not system instructions.

Set `context_window_tokens` to the model's window size. Lain reserves space for
tool schemas and the response (by default one quarter of the window, up to 4,096
tokens). It keeps instructions, the scratchpad, and procedural rules intact;
older tool outputs and the repo outline can be trimmed. If required context
cannot fit, the turn stops before calling the provider. Token counts are
estimates for OpenAI-compatible servers with non-OpenAI tokenizers.

On Windows the client uses the system Windows PowerShell `Start-Process` launcher
without redirection to start a hidden daemon. Null stdio on a direct Rust spawn
does not prevent other inheritable redirected pipe handles from reaching the
daemon. The short-lived launcher exits after spawning; clients still wait for a
successful IPC Ping, not just launcher success. Paths are quoted as literal data,
and the script uses UTF-16LE `-EncodedCommand`. Unix spawning is unchanged.

### Windows handle-inheritance verification

From this branch on a native Windows machine, run:

```powershell
cargo test -p lain-cli --test windows_spawn windows_clients_reach_eof_before_daemon_exit -- --exact --nocapture
```

Expect **1 passed**. The test copies `lain.exe` into a directory containing spaces,
an apostrophe and non-ASCII text; it captures both stdout and stderr from `start`,
`query`, and `memory inspect`. Each client must reach EOF within 12 seconds while
its spawned daemon still answers Ping. `start` and `query` intentionally use a
missing config and exit nonzero without contacting a provider; memory inspection
must succeed. The test uses unique pipe names and stops its daemons through CIM
after each case. It needs the standard Windows PowerShell/CIM components.

## Interaction and output

Interactive commands: `/quit`, `/status`, `/memory`, `/cancel`. Ctrl-C during a turn
sends `CancelTurn`, as does typing `/cancel` while it runs; other input during a
turn is ignored. Cancellation terminates that runner and the next prompt uses
a new session. The scratchpad remains displayed above the next prompt, clipped
to six lines and the terminal width. Model/tool text is filtered for terminal
control characters. Tool badges go to stderr; answer text goes to stdout.

Runner Thinking/OutputGenerated messages arrive whole, **not as provider tokens**.
TTY output uses a braille activity spinner and colored badges. Redirect stdout or
pass `--plain` for plain output without ANSI, spinners, or bordered boxes. `query`
exits nonzero on an Error or a non-success termination. Memory inspection shows
recent untrusted transcript episodes separately from locally synthesized procedural
rules; it does not promote either into approved facts.

Linux integration tests use an injected scripted provider and make zero network
calls. Windows is cross-type-checked; native Windows runtime behavior is unverified.
