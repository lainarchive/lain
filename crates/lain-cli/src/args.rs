use std::path::PathBuf;

use lain_ipc::Endpoint;

use crate::Error;

pub const USAGE: &str = "lain — local agent CLI

Usage:
  lain tui [demo]                      Terminal lane view (demo: offline sample)
  lain daemon [--no-ui]                IPC daemon + dashboard (default)
  lain run \"prompt\" [--json]           Streaming reply and observed evidence report
  lain doctor [--json]                 Bounded, offline-safe environment checks

Secondary commands:
  lain ui                             Dashboard at http://127.0.0.1:4040
  lain start
  lain query \"prompt\"
  lain memory inspect [--limit N] [--session ID]

Options (before or after the command):
  --endpoint PATH   IPC endpoint; defaults to LAIN_IPC_ENDPOINT or the OS default
  --config PATH     AgentConfig JSON; defaults to LAIN_CONFIG or ./lain.json
  --plain           No colors, spinner, or terminal boxes
  --json            Machine-readable run/doctor report (no streamed stdout text)
  --help, -h        Show this help

The daemon opens LAIN_MEMORY_DB or ./.lain/memory.db in its working directory.
Shell tools are disabled unless the daemon's environment has LAIN_ALLOW_SHELL=1.
Unix default: $XDG_RUNTIME_DIR/lain-ipc.sock or a user-scoped temporary socket.
No provider is contacted until a configured session receives a message.
Provider token deltas stream to the TUI; plain clients print completed messages.
--no-ui disables the daemon dashboard. --serve-ui remains a compatibility alias.
Interactive commands: /quit, /status, /memory, /cancel. Ctrl-C cancels a turn.
run exits: 0 completed with verified bounded claims; 2 completed but unverified;
1 failure (including tool failure, cancellation or disconnect). doctor: 1 if any ✗.
";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    Help,
    Daemon,
    Start,
    Tui { demo: bool },
    Query(String),
    Run(String),
    Doctor,
    Memory { limit: u32, session: Option<String> },
}

#[derive(Debug, Clone)]
pub struct Options {
    pub action: Action,
    pub endpoint: Endpoint,
    pub config: PathBuf,
    pub plain: bool,
    pub serve_ui: bool,
    pub json: bool,
}

impl Options {
    pub fn parse(args: impl IntoIterator<Item = String>) -> Result<Self, Error> {
        let mut args = args.into_iter();
        let mut endpoint = std::env::var_os("LAIN_IPC_ENDPOINT")
            .map(PathBuf::from)
            .map(Endpoint)
            .unwrap_or_default();
        let mut config = std::env::var_os("LAIN_CONFIG")
            .map(PathBuf::from)
            .unwrap_or_else(|| "lain.json".into());
        let mut plain = false;
        let mut json = false;
        let mut help = false;
        let mut serve_ui = true;
        let mut ui_option = false;
        let mut positional = Vec::new();
        let mut limit = None;
        let mut session = None;
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--help" | "-h" => help = true,
                "--plain" => plain = true,
                "--json" => json = true,
                "--serve-ui" => ui_option = true,
                "--no-ui" => {
                    serve_ui = false;
                    ui_option = true;
                }
                "--endpoint" | "--config" | "--limit" | "--session" => {
                    let value = args
                        .next()
                        .filter(|value| !value.starts_with("--") && !value.is_empty())
                        .ok_or_else(|| {
                            Error::failure("CLI_ARGUMENTS", format!("{arg} requires a value"))
                        })?;
                    match arg.as_str() {
                        "--endpoint" => endpoint = Endpoint(value.into()),
                        "--config" => config = value.into(),
                        "--session" => session = Some(value),
                        _ => {
                            limit = Some(
                                value
                                    .parse::<u32>()
                                    .ok()
                                    .filter(|n| (1..=100).contains(n))
                                    .ok_or_else(|| {
                                        Error::failure("CLI_ARGUMENTS", "--limit must be 1..=100")
                                    })?,
                            )
                        }
                    }
                }
                _ if arg.starts_with('-') => {
                    return Err(Error::failure(
                        "CLI_ARGUMENTS",
                        format!("Unknown option {arg}"),
                    ))
                }
                _ => positional.push(arg),
            }
        }
        let action = if help || positional.is_empty() {
            Action::Help
        } else {
            match positional
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>()
                .as_slice()
            {
                ["daemon"] => Action::Daemon,
                ["ui"] => Action::Daemon,
                ["start"] => Action::Start,
                ["tui"] => Action::Tui { demo: false },
                ["tui", "demo"] => Action::Tui { demo: true },
                ["query", prompt] if !prompt.trim().is_empty() => Action::Query((*prompt).into()),
                ["run", prompt] if !prompt.trim().is_empty() => Action::Run((*prompt).into()),
                ["doctor"] => Action::Doctor,
                ["memory", "inspect"] => Action::Memory {
                    limit: limit.unwrap_or(20),
                    session: session.clone(),
                },
                _ => {
                    return Err(Error::failure(
                        "CLI_ARGUMENTS",
                        "Unknown command or unexpected arguments; use --help",
                    ))
                }
            }
        };
        if ui_option && !matches!(action, Action::Daemon | Action::Help) {
            return Err(Error::failure(
                "CLI_ARGUMENTS",
                "--serve-ui and --no-ui require daemon or ui",
            ));
        }
        if !matches!(action, Action::Memory { .. } | Action::Help)
            && (limit.is_some() || session.is_some())
        {
            return Err(Error::failure(
                "CLI_ARGUMENTS",
                "--limit and --session require memory inspect",
            ));
        }
        if json && !matches!(action, Action::Run(_) | Action::Doctor | Action::Help) {
            return Err(Error::failure(
                "CLI_ARGUMENTS",
                "--json requires run or doctor",
            ));
        }
        Ok(Self {
            action,
            endpoint,
            config,
            plain,
            serve_ui,
            json,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<Options, Error> {
        Options::parse(args.iter().map(|arg| (*arg).into()))
    }

    #[test]
    fn commands_and_options() -> Result<(), Error> {
        assert!(matches!(
            parse(&["run", "hello", "--json"])?.action,
            Action::Run(_)
        ));
        assert_eq!(parse(&["doctor", "--json"])?.action, Action::Doctor);
        assert!(parse(&["daemon"])?.serve_ui);
        assert!(parse(&["ui"])?.serve_ui);
        assert!(parse(&["daemon", "--serve-ui"])?.serve_ui);
        assert!(!parse(&["daemon", "--no-ui"])?.serve_ui);
        assert!(!parse(&["daemon", "--no-ui", "--serve-ui"])?.serve_ui);
        assert!(!parse(&["daemon", "--serve-ui", "--no-ui"])?.serve_ui);
        assert!(!parse(&["ui", "--no-ui"])?.serve_ui);
        assert_eq!(parse(&[])?.action, Action::Help);
        assert_eq!(parse(&["--help"])?.action, Action::Help);
        assert_eq!(parse(&["daemon"])?.action, Action::Daemon);
        assert_eq!(parse(&["start"])?.action, Action::Start);
        assert_eq!(parse(&["tui"])?.action, Action::Tui { demo: false });
        assert_eq!(parse(&["tui", "demo"])?.action, Action::Tui { demo: true });
        let args = parse(&[
            "--endpoint",
            "custom",
            "query",
            "two words",
            "--config",
            "agent.json",
            "--plain",
        ])?;
        assert_eq!(args.action, Action::Query("two words".into()));
        assert_eq!(args.endpoint.0, PathBuf::from("custom"));
        assert_eq!(args.config, PathBuf::from("agent.json"));
        assert!(args.plain);
        assert_eq!(
            parse(&["memory", "inspect", "--session", "s", "--limit", "3"])?.action,
            Action::Memory {
                limit: 3,
                session: Some("s".into())
            }
        );
        Ok(())
    }

    #[test]
    fn rejects_bad_arguments() {
        assert!(parse(&["run"]).is_err());
        assert!(parse(&["run", ""]).is_err());
        assert!(parse(&["doctor", "extra"]).is_err());
        assert!(parse(&["query", "hi", "--json"]).is_err());
        for args in [
            vec!["query"],
            vec!["query", ""],
            vec!["query", "a", "b"],
            vec!["unknown"],
            vec!["--bad"],
            vec!["start", "--no-ui"],
            vec!["tui", "--serve-ui"],
            vec!["start", "--endpoint"],
            vec!["start", "--config", "--plain"],
            vec!["start", "--limit", "2"],
            vec!["memory", "inspect", "--limit", "0"],
            vec!["memory", "inspect", "--limit", "101"],
            vec!["memory", "inspect", "--limit", "x"],
        ] {
            assert!(parse(&args).is_err(), "{args:?}");
        }
    }
}
