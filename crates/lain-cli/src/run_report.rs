use std::{
    collections::{BTreeMap, BTreeSet},
    io::{self, Write},
};

use lain_harness::evidence::{Evidence, StepReport};
use lain_ipc::{Command, Event};
use serde::Serialize;

#[derive(Debug, Serialize, Default)]
pub struct RunReport {
    pub completed: bool,
    pub reply: String,
    pub steps: Vec<StepReport>,
    pub failure: Option<String>,
    #[serde(skip)]
    calls: BTreeMap<String, (usize, Option<String>)>,
    #[serde(skip)]
    streamed: String,
    #[serde(skip)]
    builtin_shells: BTreeSet<String>,
}

impl RunReport {
    pub fn event(&mut self, event: &Event) {
        match event {
            Event::Tools { tools, .. } => {
                self.builtin_shells = tools
                    .iter()
                    .filter(|tool| {
                        matches!(tool.source, lain_ipc::ToolSource::Builtin)
                            && matches!(tool.name.as_str(), "bash" | "powershell")
                    })
                    .map(|tool| tool.name.clone())
                    .collect();
            }
            Event::TokenDelta { text, .. } => self.streamed.push_str(text),
            Event::StreamToken { text, .. } => {
                if !self.reply.is_empty() {
                    self.reply.push('\n');
                }
                self.reply.push_str(text);
                self.streamed.clear();
            }
            Event::ToolStarted {
                call_id,
                name,
                arguments,
                ..
            } => {
                let command = if self.builtin_shells.contains(name) {
                    arguments
                        .get("command")
                        .and_then(|v| v.as_str())
                        .map(str::to_owned)
                } else {
                    None
                };
                self.calls
                    .insert(call_id.clone(), (self.steps.len(), command));
                self.steps.push(StepReport::new(call_id,format!("Only the reported execution of {name}; not the assistant's broader correctness claims")));
            }
            Event::ToolFinished {
                call_id,
                ok,
                exit_code,
                ..
            } => {
                if let Some((index, command)) = self.calls.remove(call_id) {
                    if let Some(step) = self.steps.get_mut(index) {
                        let _ = step.prepare();
                        if let (Some(command), Some(exit_code)) = (command, *exit_code) {
                            let _ = step.verify(vec![Evidence::TestRun {
                                command,
                                exit_code,
                                output_tail: None,
                            }]);
                        }
                    }
                }
                if !ok || exit_code.is_some_and(|code| code != 0) {
                    self.failure = Some("A daemon-reported tool failed".into());
                }
            }
            Event::Error { code, .. } => self.failure = Some(format!("Daemon error: {code}")),
            Event::SessionCompleted { reason, .. } => {
                self.completed = reason == "completed";
                if !self.completed {
                    self.failure = Some(format!("Turn ended: {reason}"));
                }
                if self.steps.is_empty() {
                    let mut step = StepReport::new(
                        "reply",
                        "Assistant reply only; no command execution was observed",
                    );
                    let _ = step.prepare();
                    self.steps.push(step);
                }
            }
            _ => {}
        }
    }

    pub fn exit_code(&self) -> u8 {
        if !self.completed || self.failure.is_some() {
            1
        } else if self.steps.is_empty() || self.steps.iter().any(|step| !step.is_done()) {
            2
        } else {
            0
        }
    }
}

pub async fn execute(options: &crate::args::Options, prompt: String) -> Result<u8, crate::Error> {
    let mut report = RunReport::default();
    let result=async {
        let mut client=crate::ui::connect_or_spawn(options).await?;
        let session=crate::ui::start_session(&mut client,&mut crate::ui::Renderer::new(true)).await?;
        for event in client.request(Command::ListTools {session_id:session.clone()}).await? {
            if matches!(event,Event::Tools {..}) {report.event(&event);}
        }
        let id=client.send(Command::SendMessage {session_id:session.clone(),text:prompt,stream_deltas:true}).await?;
        loop {
            let next=tokio::select! {
                event=client.recv()=>event?,
                signal=tokio::signal::ctrl_c()=> {
                    signal?;let _=client.send(Command::CancelTurn {session_id:session.clone()}).await;
                    return Err(crate::Error::failure("RUN_CANCELLED","Turn interrupted"));
                }
            };
            let (reply,event)=next.ok_or_else(||crate::Error::failure("DAEMON_CLOSED","Daemon disconnected"))?;
            if reply!=id {continue;}
            if !options.json {
                let mut out=io::stdout().lock();
                match &event {
                    Event::TokenDelta {text,..}=>write!(out,"{}",crate::render::clean(text))?,
                    Event::StreamToken {text,..}=> {
                        if let Some(tail)=text.strip_prefix(&report.streamed) {writeln!(out,"{}",crate::render::clean(tail))?;}
                        else {writeln!(out,"\n[final message]\n{}",crate::render::clean(text))?;}
                    }
                    _=>{}
                }
                out.flush()?;
            }
            report.event(&event);
            if matches!(event,Event::SessionCompleted {..}|Event::Error {..}) {break;}
        }
        client.close().await?;
        Ok::<(),crate::Error>(())
    }.await;
    if let Err(error) = result {
        report.failure = Some(error.code().into());
    }
    if !report.streamed.is_empty() {
        report.reply.push_str(&report.streamed);
    }
    let mut out = io::stdout().lock();
    if options.json {
        writeln!(out, "{}", serde_json::to_string_pretty(&report)?)?;
    } else {
        writeln!(out, "\nEvidence report (exit {}):", report.exit_code())?;
        for step in &report.steps {
            writeln!(
                out,
                "{} · {}\n  claim_boundary: {}",
                step.step_id(),
                serde_json::to_value(step.status())?,
                crate::render::clean(step.claim_boundary())
            )?;
            for evidence in step.evidence() {
                writeln!(out, "  observed: {}", serde_json::to_string(evidence)?)?;
            }
        }
        if let Some(failure) = &report.failure {
            writeln!(out, "Failure: {}", crate::render::clean(failure))?;
        }
    }
    Ok(report.exit_code())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_observed_zero_exit_commands_verify_a_bounded_claim() {
        for (exit, ok, expected) in [(None, true, 2), (Some(0), true, 0), (Some(4), false, 1)] {
            let mut report = RunReport::default();
            report.event(&Event::Tools {
                session_id: "s".into(),
                allow_creator_mode: false,
                tools: vec![lain_ipc::ActiveTool {
                    name: "bash".into(),
                    description: String::new(),
                    parameters: json!({}),
                    source: lain_ipc::ToolSource::Builtin,
                    permissions: vec![],
                }],
            });
            assert_eq!(report.exit_code(), 1);
            report.event(&Event::ToolStarted {
                session_id: "s".into(),
                call_id: "c".into(),
                name: "bash".into(),
                arguments: json!({"command":"cargo test"}),
            });
            report.event(&Event::ToolFinished {
                session_id: "s".into(),
                call_id: "c".into(),
                name: "bash".into(),
                summary: String::new(),
                ok,
                exit_code: exit,
            });
            report.event(&Event::SessionCompleted {
                session_id: "s".into(),
                reason: "completed".into(),
                scratchpad: None,
            });
            assert_eq!(report.exit_code(), expected);
        }
    }

    #[test]
    fn reply_only_and_unfinished_steps_do_not_verify() {
        let mut report = RunReport::default();
        report.event(&Event::TokenDelta {
            session_id: "s".into(),
            turn: 1,
            text: "hel".into(),
        });
        report.event(&Event::StreamToken {
            session_id: "s".into(),
            text: "hello".into(),
        });
        report.event(&Event::SessionCompleted {
            session_id: "s".into(),
            reason: "completed".into(),
            scratchpad: None,
        });
        assert_eq!(report.reply, "hello");
        assert_eq!(report.exit_code(), 2);
    }

    #[test]
    fn a_plugin_named_bash_cannot_supply_builtin_command_evidence() {
        let mut report = RunReport::default();
        report.event(&Event::Tools {
            session_id: "s".into(),
            allow_creator_mode: false,
            tools: vec![lain_ipc::ActiveTool {
                name: "bash".into(),
                description: String::new(),
                parameters: json!({}),
                source: lain_ipc::ToolSource::Plugin {
                    manifest_name: "bash".into(),
                    manifest_path: None,
                },
                permissions: vec![],
            }],
        });
        report.event(&Event::ToolStarted {
            session_id: "s".into(),
            call_id: "c".into(),
            name: "bash".into(),
            arguments: json!({"command":"cargo test"}),
        });
        report.event(&Event::ToolFinished {
            session_id: "s".into(),
            call_id: "c".into(),
            name: "bash".into(),
            ok: true,
            summary: String::new(),
            exit_code: Some(0),
        });
        report.event(&Event::SessionCompleted {
            session_id: "s".into(),
            reason: "completed".into(),
            scratchpad: None,
        });
        assert_eq!(report.exit_code(), 2);
    }
}
