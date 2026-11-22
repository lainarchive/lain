use std::collections::BTreeMap;

use lain_ipc::{Command, Event, IpcClient, SessionMode};

use super::{
    creator::{Creator, Operation},
    state::{Effect, Mode},
};
use crate::Error;

enum Kind {
    Access,
    Run(Operation),
}

#[derive(Default)]
pub struct Requests {
    pending: BTreeMap<u64, (String, Kind)>,
}

impl Requests {
    pub fn clear(&mut self) -> Vec<u64> {
        std::mem::take(&mut self.pending).into_keys().collect()
    }

    pub async fn access(
        &mut self,
        client: &mut IpcClient,
        session: Option<&str>,
        creator: &mut Creator,
    ) -> Result<(), Error> {
        creator.access_loaded = true;
        if let Some(session) = session {
            let id = client
                .send(Command::ListTools {
                    session_id: session.into(),
                })
                .await?;
            self.pending.insert(id, (session.into(), Kind::Access));
        } else {
            creator.access_error = Some("No active session; use Ctrl+K → New session".into());
        }
        Ok(())
    }

    pub async fn submit(
        &mut self,
        client: &mut IpcClient,
        session: Option<&str>,
        creator: &mut Creator,
        mode: Mode,
        operation: Operation,
    ) -> Result<(), Error> {
        if creator.request(mode, operation) == Effect::None {
            return Ok(());
        }
        let Some(session) = session else {
            creator.access_error = Some("No active session; use Ctrl+K → New session".into());
            return Ok(());
        };
        let proposal = match creator.proposal() {
            Ok(proposal) => proposal,
            Err(error) => {
                creator.error = Some(error);
                return Ok(());
            }
        };
        let command = match operation {
            Operation::Test => Command::TestToolProposal {
                session_id: session.into(),
                proposal,
            },
            Operation::Publish => Command::PublishToolProposal {
                session_id: session.into(),
                proposal,
                mode: match mode {
                    Mode::Code => SessionMode::Code,
                    Mode::Architect => SessionMode::Architect,
                    Mode::Ask => SessionMode::Ask,
                },
            },
        };
        let id = client.send(command).await?;
        creator.busy = true;
        creator.error = None;
        creator.report = None;
        self.pending
            .insert(id, (session.into(), Kind::Run(operation)));
        Ok(())
    }

    pub fn event(&mut self, id: u64, event: &Event, creator: &mut Creator) -> bool {
        let Some((session, kind)) = self.pending.remove(&id) else {
            return false;
        };
        match (kind, event) {
            (
                Kind::Access,
                Event::Tools {
                    session_id,
                    allow_creator_mode,
                    ..
                },
            ) if session_id == &session => creator.set_access(*allow_creator_mode),
            (
                Kind::Run(operation),
                Event::ToolProposalResult {
                    session_id,
                    execution,
                    written_paths,
                },
            ) if session_id == &session => {
                creator.finish(operation, execution.clone(), written_paths.clone(), false);
            }
            (kind, event) => {
                let error = match event {
                    Event::Error { code, message }
                        if matches!(
                            code.as_str(),
                            "IPC_INVALID_FRAME" | "IPC_COMMAND_UNSUPPORTED"
                        ) =>
                    {
                        let error =
                            format!("Daemon does not support Creator requests ({code}): {message}");
                        creator.access_error = Some(error.clone());
                        error
                    }
                    Event::Error { code, message } => {
                        if code == "TOOL_NOT_FOUND" {
                            creator.set_access(false);
                        }
                        if code == "TOOL_PERMISSION_DENIED" {
                            creator.access_error =
                                Some(format!("Daemon refused Creator permission: {message}"));
                        }
                        format!("{code}: {message}")
                    }
                    _ => "Unexpected Creator response or mismatched session".into(),
                };
                match kind {
                    Kind::Access => {
                        creator.allowed = None;
                        creator.access_error = Some(error);
                    }
                    Kind::Run(_) => {
                        creator.busy = false;
                        creator.error = Some(error);
                    }
                }
            }
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refusals_are_local_and_replies_are_session_correlated() {
        let mut creator = Creator::sample();
        let mut requests = Requests::default();
        requests
            .pending
            .insert(1, ("s".into(), Kind::Run(Operation::Publish)));
        creator.busy = true;
        assert!(requests.event(
            1,
            &Event::Error {
                code: "TOOL_NOT_FOUND".into(),
                message: "unknown tool: create_tool".into()
            },
            &mut creator
        ));
        assert_eq!(creator.allowed, Some(false));
        assert!(!creator.busy);
        assert!(creator.disabled(Mode::Code, Operation::Publish).is_some());
        assert!(!requests.event(
            2,
            &Event::Error {
                code: "SESSION_BUSY".into(),
                message: "s".into()
            },
            &mut creator
        ));
        requests.pending.insert(3, ("s".into(), Kind::Access));
        requests.event(
            3,
            &Event::Error {
                code: "IPC_INVALID_FRAME".into(),
                message: "unknown request".into(),
            },
            &mut creator,
        );
        assert!(creator
            .access_error
            .as_deref()
            .is_some_and(|error| error.contains("does not support Creator")));
        requests.pending.insert(4, ("s".into(), Kind::Access));
        requests.event(
            4,
            &Event::Tools {
                session_id: "wrong".into(),
                allow_creator_mode: true,
                tools: vec![],
            },
            &mut creator,
        );
        assert_ne!(creator.allowed, Some(true));
        requests.pending.insert(5, ("s".into(), Kind::Access));
        requests.event(
            5,
            &Event::Tools {
                session_id: "s".into(),
                allow_creator_mode: true,
                tools: vec![],
            },
            &mut creator,
        );
        assert_eq!(creator.allowed, Some(true));
        let execution = lain_ipc::ScriptExecution {
            exit_code: Some(0),
            stdout: "raw output".into(),
            stderr: "trace".into(),
            result: Some(serde_json::Value::Null),
            duration_ms: 7,
            error: None,
        };
        creator.busy = true;
        requests
            .pending
            .insert(6, ("s".into(), Kind::Run(Operation::Publish)));
        requests.event(
            6,
            &Event::ToolProposalResult {
                session_id: "s".into(),
                execution,
                written_paths: vec![
                    ".lain/tools/tool-demo_created.py".into(),
                    ".lain/tools/tool-demo_created.json".into(),
                ],
            },
            &mut creator,
        );
        assert!(!creator.busy);
        let report = creator.report.as_ref().expect("missing daemon result");
        assert!(!report.simulated);
        assert_eq!(report.paths.len(), 2);
        assert_eq!(report.execution.result, Some(serde_json::Value::Null));
        assert_eq!(report.execution.stdout, "raw output");
        assert_eq!(report.execution.stderr, "trace");
        assert_eq!(report.execution.duration_ms, 7);
        assert!(requests.clear().is_empty());
    }
}
