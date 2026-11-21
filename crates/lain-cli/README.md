# `lain` Rust CLI

Build with `cargo build -p lain-cli`, then run `target/debug/lain --help`.

```text
lain start
lain query "Summarize the current task"
lain memory inspect --limit 10 --session SESSION_ID
lain daemon --endpoint /path/to/lain.sock --config /path/to/lain.json
```

`start`, `query`, and `memory inspect` ping the daemon and spawn the same binary's
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

Set `coding_session: true` to attach a compact Rust/TypeScript outline to the
first model prompt and enable `repo_map` to request a fresh scan. The tool takes no
path argument; the workspace is the daemon's original working directory. The
scan skips hidden paths, links, and common build/vendor directories, but does not
interpret `.gitignore`. Enable this only if the configured provider may receive
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
