#[cfg(unix)]
use std::time::Duration;
use std::{
    collections::HashMap,
    future::Future,
    path::PathBuf,
    pin::Pin,
    sync::{Arc, Mutex},
};

use lain_agent::{
    runner::{new_session_id, Canceller},
    AgentConfig, AgentEvent, AgentRunner, AgentStatus, ToolOutcome,
};
#[cfg(unix)]
use lain_core::tools::BashTool;
#[cfg(windows)]
use lain_core::tools::PowerShellTool;
use lain_core::tools::{MemoryReadTool, ToolRegistry};
use lain_ipc::{Command, CommandHandler, Event, EventSink, PROTOCOL_VERSION};
use lain_memory::MemoryStore;
use tokio::sync::{broadcast, Mutex as AsyncMutex, RwLock};

use crate::Error;

pub type SharedMemory = Arc<Mutex<MemoryStore>>;

pub trait RunnerFactory: Send + Sync + 'static {
    fn create(&self, id: &str, memory: SharedMemory) -> Result<AgentRunner, Error>;
}

#[derive(Debug)]
pub struct ConfigFactory {
    pub config_path: PathBuf,
    pub working_directory: PathBuf,
}

impl RunnerFactory for ConfigFactory {
    fn create(&self, id: &str, memory: SharedMemory) -> Result<AgentRunner, Error> {
        let bytes = std::fs::read(&self.config_path).map_err(|error| {
            Error::failure(
                if error.kind() == std::io::ErrorKind::NotFound {
                    "CONFIG_NOT_FOUND"
                } else {
                    "CONFIG_READ_FAILED"
                },
                format!("{}: {error}", self.config_path.display()),
            )
        })?;
        let config: AgentConfig = serde_json::from_slice(&bytes)
            .map_err(|error| Error::failure("CONFIG_INVALID", error))?;
        config.validate()?;
        let mut tools = ToolRegistry::new();
        #[cfg(unix)]
        tools.register(Arc::new(BashTool {
            working_directory: self.working_directory.clone(),
            timeout: Duration::from_secs(30),
            output_byte_cap: 64 * 1024,
        }))?;
        #[cfg(windows)]
        tools.register(Arc::new(PowerShellTool::new(&self.working_directory)))?;
        tools.register(Arc::new(MemoryReadTool::new(memory.clone())))?;
        Ok(AgentRunner::from_config(
            config,
            Arc::new(tools),
            memory,
            id,
        )?)
    }
}

struct Session {
    runner: AsyncMutex<AgentRunner>,
    canceller: Canceller,
}

pub struct DaemonHandler {
    memory: SharedMemory,
    factory: Arc<dyn RunnerFactory>,
    sessions: RwLock<HashMap<String, Arc<Session>>>,
}

impl std::fmt::Debug for DaemonHandler {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DaemonHandler").finish_non_exhaustive()
    }
}

impl DaemonHandler {
    pub fn new(memory: SharedMemory, factory: Arc<dyn RunnerFactory>) -> Self {
        Self {
            memory,
            factory,
            sessions: RwLock::new(HashMap::new()),
        }
    }

    async fn session(&self, id: &str) -> Result<Arc<Session>, Error> {
        self.sessions
            .read()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| Error::failure("SESSION_NOT_FOUND", id))
    }

    pub async fn cancel_all(&self) {
        for session in self.sessions.read().await.values() {
            session.canceller.cancel();
        }
    }

    async fn dispatch(&self, command: Command, events: &EventSink) -> Result<(), Error> {
        match command {
            Command::Ping => {
                events
                    .send(Event::Pong {
                        server_version: PROTOCOL_VERSION,
                    })
                    .await?
            }
            Command::StartSession { session_id } => {
                let id = session_id.unwrap_or_else(new_session_id);
                let mut sessions = self.sessions.write().await;
                if sessions.contains_key(&id) {
                    return Err(Error::failure("SESSION_EXISTS", &id));
                }
                let runner = self.factory.create(&id, self.memory.clone())?;
                let canceller = runner.canceller();
                sessions.insert(
                    id.clone(),
                    Arc::new(Session {
                        runner: AsyncMutex::new(runner),
                        canceller,
                    }),
                );
                drop(sessions);
                events
                    .send(Event::SessionStarted { session_id: id })
                    .await?;
            }
            Command::SendMessage { session_id, text } => self.run(session_id, text, events).await?,
            Command::CancelTurn { session_id } => {
                self.session(&session_id).await?.canceller.cancel();
                events
                    .send(Event::Status {
                        session_id: Some(session_id),
                        status: "cancelling".into(),
                        scratchpad: None,
                    })
                    .await?;
            }
            Command::GetStatus { session_id } => {
                let (status, scratchpad) = if let Some(id) = &session_id {
                    let session = self.session(id).await?;
                    let snapshot = match session.runner.try_lock() {
                        Ok(runner) => (
                            serde_json::to_string(&runner.state().status)?,
                            Some(runner.state().scratchpad.plan.clone()),
                        ),
                        Err(_) => (
                            "running".into(),
                            self.memory
                                .lock()
                                .map_err(|_| Error::failure("MEMORY_LOCK", "Memory lock poisoned"))?
                                .scratchpad(id)?,
                        ),
                    };
                    snapshot
                } else {
                    (
                        format!("ready ({} sessions)", self.sessions.read().await.len()),
                        None,
                    )
                };
                events
                    .send(Event::Status {
                        session_id,
                        status,
                        scratchpad,
                    })
                    .await?;
            }
            Command::InspectMemory { session_id, limit } => {
                let limit = limit.unwrap_or(20).min(100) as usize;
                let (episodic, procedural) = {
                    let store = self
                        .memory
                        .lock()
                        .map_err(|_| Error::failure("MEMORY_LOCK", "Memory lock poisoned"))?;
                    (
                        store
                            .recent_episodes(session_id.as_deref(), limit)?
                            .into_iter()
                            .map(|record| format!("{}: {}", record.title, record.content))
                            .collect(),
                        store.recent_procedural_rules(session_id.as_deref(), limit)?,
                    )
                };
                events
                    .send(Event::Memory {
                        episodic,
                        procedural,
                    })
                    .await?;
            }
            _ => {
                return Err(Error::failure(
                    "IPC_COMMAND_UNSUPPORTED",
                    "Unsupported command",
                ))
            }
        }
        Ok(())
    }

    async fn run(&self, id: String, text: String, events: &EventSink) -> Result<(), Error> {
        let session = self.session(&id).await?;
        let mut runner = session
            .runner
            .try_lock()
            .map_err(|_| Error::failure("SESSION_BUSY", &id))?;
        let mut source = runner.subscribe();
        let result = {
            let run = runner.run(text);
            tokio::pin!(run);
            loop {
                tokio::select! {
                    biased;
                    event = source.recv() => forward_agent_event(&id, event, events).await?,
                    result = &mut run => break result,
                    _ = events.closed() => { session.canceller.cancel(); break run.await; }
                }
            }
        };
        while let Ok(event) = source.try_recv() {
            if let Some(event) = map_agent_event(&id, event) {
                events.send(event).await?;
            }
        }
        if let Err(error) = result {
            events
                .send(Event::Error {
                    code: error.code().into(),
                    message: error.to_string(),
                })
                .await?;
        }
        if runner.state().inputs > 0
            && matches!(
                runner.state().status,
                AgentStatus::AwaitingInput | AgentStatus::Terminated(_)
            )
        {
            match runner.reflect_and_compact(&id).await {
                Ok(reflection) => {
                    events
                        .send(Event::ReflectionGenerated {
                            session_id: id.clone(),
                            summary: format!(
                                "{} turns, {} tool calls",
                                reflection.turns, reflection.tool_calls
                            ),
                            rules: reflection.rules,
                        })
                        .await?
                }
                Err(error) => {
                    events
                        .send(Event::Error {
                            code: error.code().into(),
                            message: error.to_string(),
                        })
                        .await?
                }
            }
        }
        let reason = if runner.state().status == AgentStatus::AwaitingInput {
            "completed".into()
        } else {
            serde_json::to_string(&runner.state().status)?
        };
        events
            .send(Event::SessionCompleted {
                session_id: id,
                reason,
                scratchpad: Some(runner.state().scratchpad.plan.clone()),
            })
            .await?;
        Ok(())
    }
}

async fn forward_agent_event(
    id: &str,
    event: Result<AgentEvent, broadcast::error::RecvError>,
    events: &EventSink,
) -> Result<(), Error> {
    let event = event.map_err(|error| Error::failure("AGENT_EVENTS_LOST", error))?;
    if let Some(event) = map_agent_event(id, event) {
        events.send(event).await?;
    }
    Ok(())
}

pub fn map_agent_event(id: &str, event: AgentEvent) -> Option<Event> {
    let session_id = id.to_owned();
    match event {
        AgentEvent::Thinking { text, .. } | AgentEvent::OutputGenerated { text, .. } => {
            Some(Event::StreamToken { session_id, text })
        }
        AgentEvent::ToolInvoked {
            call_id,
            name,
            arguments,
            ..
        } => Some(Event::ToolStarted {
            session_id,
            call_id,
            name,
            arguments,
        }),
        AgentEvent::ToolCompleted {
            call_id,
            name,
            outcome,
            ..
        } => {
            let ok = matches!(&outcome, ToolOutcome::Succeeded(output) if output.exit_code.is_none_or(|code| code == 0));
            let summary = match outcome {
                ToolOutcome::Succeeded(output) => output.content,
                ToolOutcome::Failed { message, .. } => message,
                ToolOutcome::Skipped { reason } | ToolOutcome::Interrupted { reason } => reason,
            };
            Some(Event::ToolFinished {
                session_id,
                call_id,
                name,
                ok,
                summary,
            })
        }
        AgentEvent::ReflectionFailed { code } => Some(Event::Error {
            code,
            message: "Session reflection could not be stored".into(),
        }),
        _ => None,
    }
}

impl CommandHandler for DaemonHandler {
    fn handle(
        &self,
        command: Command,
        events: EventSink,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            if let Err(error) = self.dispatch(command, &events).await {
                let _ = events
                    .send(Event::Error {
                        code: error.code().into(),
                        message: error.to_string(),
                    })
                    .await;
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lain_agent::TerminationReason;
    use lain_core::tools::ToolOutput;
    use serde_json::json;

    #[test]
    fn event_mapping() {
        for event in [
            AgentEvent::Thinking {
                turn: 1,
                text: "thinking".into(),
            },
            AgentEvent::OutputGenerated {
                turn: 1,
                text: "answer".into(),
            },
        ] {
            assert!(
                matches!(map_agent_event("s", event), Some(Event::StreamToken { session_id, .. }) if session_id == "s")
            );
        }
        assert!(matches!(map_agent_event("s", AgentEvent::ToolInvoked {
            turn: 1, call_id: "c".into(), name: "tool".into(), arguments: json!({"a":1}),
        }), Some(Event::ToolStarted { call_id, arguments, .. }) if call_id == "c" && arguments == json!({"a":1})));
        for (outcome, expected) in [
            (
                ToolOutcome::Succeeded(ToolOutput {
                    content: "ok".into(),
                    exit_code: Some(0),
                }),
                true,
            ),
            (
                ToolOutcome::Succeeded(ToolOutput {
                    content: "failed".into(),
                    exit_code: Some(1),
                }),
                false,
            ),
            (
                ToolOutcome::Failed {
                    code: "X".into(),
                    message: "failed".into(),
                },
                false,
            ),
            (
                ToolOutcome::Skipped {
                    reason: "skipped".into(),
                },
                false,
            ),
            (
                ToolOutcome::Interrupted {
                    reason: "cancelled".into(),
                },
                false,
            ),
        ] {
            assert!(
                matches!(map_agent_event("s", AgentEvent::ToolCompleted { turn: 1, call_id: "c".into(), name: "tool".into(), outcome }),
                Some(Event::ToolFinished { ok, .. }) if ok == expected)
            );
        }
        assert!(
            matches!(map_agent_event("s", AgentEvent::ReflectionFailed { code: "X".into() }), Some(Event::Error { code, .. }) if code == "X")
        );
        assert!(map_agent_event(
            "s",
            AgentEvent::Terminated {
                turn: 1,
                reason: TerminationReason::Cancelled
            }
        )
        .is_none());
        assert!(map_agent_event(
            "s",
            AgentEvent::TurnStarted {
                session_id: "s".into(),
                turn: 1
            }
        )
        .is_none());
    }
}
