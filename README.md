# lain

Lain is a local-first AI operating environment. This repository contains a Rust agent
and daemon, a browser dashboard, and the earlier Node implementation. The two CLIs
are both named `lain`; use the entry point for the implementation you want.

## Where to start

| Area | Source and entry point |
| --- | --- |
| Rust CLI and daemon | [`crates/lain-cli/`](crates/lain-cli/README.md); `cargo run -p lain-cli -- --help` |
| Rust runtime | [`crates/`](crates/): `lain-agent` runs turns, `lain-core` provides model and tool interfaces, and `lain-ipc`, `lain-memory`, `lain-context`, and `lain-plugin` handle transport, memory, repository context, and extensions. |
| Neural dashboard (browser) | [`dashboard/`](dashboard/README.md) is the Next.js client; its HTTP and WebSocket bridge is in [`crates/lain-cli/src/dashboard.rs`](crates/lain-cli/src/dashboard.rs). The Rust command is `lain ui`. |
| Node CLI and terminal dashboard | [`src/`](src/) and [`test/`](test/); `node src/cli/index.mjs` for the [CLI](docs/CLI.md), or add `tui` for the [terminal dashboard](docs/ui/README.md). |
| Tooling and inputs | [`tools/check/`](tools/check/) runs Node verification, [`tools/win32/`](tools/win32/) supports Node execution on Windows, and [`tools/experiments/`](tools/experiments/) holds research probes, some used by tests. [`tasks/`](tasks/) and [`examples/`](examples/) hold task inputs. |

## Verification

From the repository root:

- Rust: `cargo fmt --all --check`, `cargo test --workspace`, and
  `cargo clippy --workspace --all-targets -- -D warnings`.
- Node: use the version in [`.node-version`](.node-version), run `npm ci`,
  then `npm test` and `npm run verify` (the latter requires gitleaks).
  Some execution tests require Windows.
- Dashboard: install separately with `npm --prefix dashboard ci`, then run
  `npm --prefix dashboard test`, `npm --prefix dashboard lint`, and
  `npm --prefix dashboard typecheck`.

## Project records

Start with [AGENTS.md](AGENTS.md) and the [`.devin/` workflows](.devin/workflows.md)
before editing. See the [current project state](docs/memory/CURRENT_STATE.md) for
recent implementation notes and the [implementation index](docs/implementation/README.md)
for subsystem details. [Architecture](ARCHITECTURE.md) describes the design;
[decisions](DECISIONS.md) track what is approved, and the
[roadmap](IMPLEMENTATION_ROADMAP.md) tracks proposed sequencing.
