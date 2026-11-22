use std::{future::Future, pin::Pin, sync::Arc, time::Duration};

use lain_ipc::{Command, CommandHandler, Endpoint, Event, EventSink, IpcServer, PROTOCOL_VERSION};
use tokio::{process::Command as Process, sync::watch, time::timeout};

#[derive(Clone, Copy)]
enum Case {
    Verified,
    Unverified,
    Failed,
    Disconnected,
}

struct Fixture {
    case: Case,
    stop: watch::Sender<bool>,
}

impl CommandHandler for Fixture {
    fn handle(
        &self,
        command: Command,
        events: EventSink,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            match command {
                Command::Ping => {
                    let _ = events
                        .send(Event::Pong {
                            server_version: PROTOCOL_VERSION,
                        })
                        .await;
                }
                Command::StartSession { .. } => {
                    let _ = events
                        .send(Event::SessionStarted {
                            session_id: "fixture".into(),
                        })
                        .await;
                }
                Command::ListTools { session_id } => {
                    let tools = ["bash", "powershell"]
                        .into_iter()
                        .map(|name| lain_ipc::ActiveTool {
                            name: name.into(),
                            description: String::new(),
                            parameters: serde_json::json!({}),
                            source: lain_ipc::ToolSource::Builtin,
                            permissions: vec![],
                        })
                        .collect();
                    let _ = events
                        .send(Event::Tools {
                            session_id,
                            allow_creator_mode: false,
                            tools,
                        })
                        .await;
                }
                Command::SendMessage {
                    stream_deltas: true,
                    ..
                } => {
                    if matches!(self.case, Case::Disconnected) {
                        let _ = self.stop.send(true);
                        return;
                    }
                    let session_id = "fixture".to_owned();
                    if matches!(self.case, Case::Verified | Case::Failed) {
                        #[cfg(unix)]
                        let (name, program, args) = (
                            "bash",
                            "/bin/sh",
                            vec![
                                "-c",
                                if matches!(self.case, Case::Failed) {
                                    "exit 7"
                                } else {
                                    "printf fixture"
                                },
                            ],
                        );
                        #[cfg(windows)]
                        let (name, program, args) = (
                            "powershell",
                            "powershell.exe",
                            vec![
                                "-NoProfile",
                                "-Command",
                                if matches!(self.case, Case::Failed) {
                                    "exit 7"
                                } else {
                                    "Write-Output fixture"
                                },
                            ],
                        );
                        let _ = events
                            .send(Event::ToolStarted {
                                session_id: session_id.clone(),
                                call_id: "check".into(),
                                name: name.into(),
                                arguments: serde_json::json!({"command":args.last().copied()}),
                            })
                            .await;
                        let code = std::process::Command::new(program)
                            .args(&args)
                            .output()
                            .ok()
                            .and_then(|output| output.status.code());
                        let _ = events
                            .send(Event::ToolFinished {
                                session_id: session_id.clone(),
                                call_id: "check".into(),
                                name: name.into(),
                                summary: "fixture".into(),
                                ok: code == Some(0),
                                exit_code: code,
                            })
                            .await;
                    }
                    let _ = events
                        .send(Event::TokenDelta {
                            session_id: session_id.clone(),
                            turn: 1,
                            text: "hel".into(),
                        })
                        .await;
                    let _ = events
                        .send(Event::TokenDelta {
                            session_id: session_id.clone(),
                            turn: 1,
                            text: "lo".into(),
                        })
                        .await;
                    let _ = events
                        .send(Event::StreamToken {
                            session_id: session_id.clone(),
                            text: "hello".into(),
                        })
                        .await;
                    let _ = events
                        .send(Event::SessionCompleted {
                            session_id,
                            reason: "completed".into(),
                            scratchpad: None,
                        })
                        .await;
                }
                _ => {
                    let _ = events
                        .send(Event::Error {
                            code: "UNEXPECTED".into(),
                            message: "Unexpected fixture command".into(),
                        })
                        .await;
                }
            }
        })
    }
}

#[tokio::test]
async fn binary_run_emits_one_report_and_honest_exit_codes()
-> Result<(), Box<dyn std::error::Error>> {
    timeout(Duration::from_secs(20), async {
        for (case, json, expected) in [
            (Case::Verified, true, 0),
            (Case::Unverified, true, 2),
            (Case::Failed, true, 1),
            (Case::Disconnected, true, 1),
            (Case::Verified, false, 0),
        ] {
            let directory = tempfile::tempdir()?;
            #[cfg(unix)]
            let endpoint = Endpoint(directory.path().join("cli.sock"));
            #[cfg(windows)]
            let endpoint = Endpoint(
                format!(
                    r"\\.\pipe\lain-launch-{}-{}",
                    std::process::id(),
                    directory
                        .path()
                        .file_name()
                        .ok_or("missing temporary directory name")?
                        .to_string_lossy()
                )
                .replace(':', "_")
                .replace('/', "_")
                .into(),
            );
            let (stop, receiver) = watch::channel(false);
            let server = tokio::spawn(IpcServer::bind(&endpoint)?.serve(
                Arc::new(Fixture {
                    case,
                    stop: stop.clone(),
                }),
                receiver,
            ));
            let mut command = Process::new(env!("CARGO_BIN_EXE_lain"));
            command
                .args(["run", "fixture prompt", "--endpoint"])
                .arg(&endpoint.0)
                .kill_on_drop(true);
            if json {
                command.arg("--json");
            }
            let output = command.output().await?;
            assert_eq!(
                output.status.code(),
                Some(expected),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            if json {
                let report: serde_json::Value = serde_json::from_slice(&output.stdout)?;
                if expected == 0 {
                    assert_eq!(
                        report.pointer("/steps/0/status"),
                        Some(&serde_json::json!("observed_verified"))
                    );
                }
                if !matches!(case, Case::Disconnected) {
                    assert_eq!(report.get("reply"), Some(&serde_json::json!("hello")));
                }
            } else {
                let text = String::from_utf8(output.stdout)?;
                assert_eq!(text.matches("hello").count(), 1);
                assert!(text.contains("Evidence report"));
            }
            let _ = stop.send(true);
            server.await??;
        }
        Ok::<(), Box<dyn std::error::Error>>(())
    })
    .await?
}
