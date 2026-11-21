use std::path::PathBuf;

use lain_ipc::Endpoint;

use crate::Error;

pub const USAGE: &str = "lain — local agent CLI

Usage:
  lain start
  lain query \"prompt\"
  lain memory inspect [--limit N] [--session ID]
  lain daemon                         (internal)

Options (before or after the command):
  --endpoint PATH   IPC endpoint; defaults to LAIN_IPC_ENDPOINT or the OS default
  --config PATH     AgentConfig JSON; defaults to LAIN_CONFIG or ./lain.json
  --plain           No colors, spinner, or terminal boxes
  --help, -h        Show this help

The daemon opens LAIN_MEMORY_DB or ./.lain/memory.db in its working directory.
Shell tools are disabled unless the daemon's environment has LAIN_ALLOW_SHELL=1.
No provider is contacted until a configured session receives a message.
Output is whole runner messages, not provider-token streaming.
Interactive commands: /quit, /status, /memory, /cancel. Ctrl-C cancels a turn.
";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    Help,
    Daemon,
    Start,
    Query(String),
    Memory { limit: u32, session: Option<String> },
}

#[derive(Debug, Clone)]
pub struct Options {
    pub action: Action,
    pub endpoint: Endpoint,
    pub config: PathBuf,
    pub plain: bool,
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
        let mut help = false;
        let mut positional = Vec::new();
        let mut limit = None;
        let mut session = None;
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--help" | "-h" => help = true,
                "--plain" => plain = true,
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
                ["start"] => Action::Start,
                ["query", prompt] if !prompt.trim().is_empty() => Action::Query((*prompt).into()),
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
        if !matches!(action, Action::Memory { .. } | Action::Help)
            && (limit.is_some() || session.is_some())
        {
            return Err(Error::failure(
                "CLI_ARGUMENTS",
                "--limit and --session require memory inspect",
            ));
        }
        Ok(Self {
            action,
            endpoint,
            config,
            plain,
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
        assert_eq!(parse(&[])?.action, Action::Help);
        assert_eq!(parse(&["--help"])?.action, Action::Help);
        assert_eq!(parse(&["daemon"])?.action, Action::Daemon);
        assert_eq!(parse(&["start"])?.action, Action::Start);
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
        for args in [
            vec!["query"],
            vec!["query", ""],
            vec!["query", "a", "b"],
            vec!["unknown"],
            vec!["--bad"],
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
