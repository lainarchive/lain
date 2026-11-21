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

Shell tools are **disabled by default**: only trusted-memory search is registered
by the factory. Set `LAIN_ALLOW_SHELL=1` in the daemon's environment to explicitly
authorize Bash (Unix) or PowerShell (Windows). Other values do not grant access.
An already-running daemon must be restarted to change this authorization.

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
