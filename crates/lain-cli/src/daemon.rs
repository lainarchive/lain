#[cfg(unix)]
use std::time::Duration;
use std::{
    collections::HashMap,
    future::Future,
    path::PathBuf,
    pin::Pin,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};

use lain_agent::{
    runner::{new_session_id, Canceller},
    AgentConfig, AgentEvent, AgentRunner, AgentStatus, ToolOutcome,
};
use lain_core::plugin::PluginManager;
#[cfg(unix)]
use lain_core::tools::BashTool;
#[cfg(windows)]
use lain_core::tools::PowerShellTool;
use lain_core::tools::{MemoryReadTool, RepoMapTool, ToolRegistry};
use lain_ipc::{Command, CommandHandler, Event, EventSink, PROTOCOL_VERSION};
use lain_memory::MemoryStore;
use tokio::sync::{broadcast, Mutex as AsyncMutex, RwLock};

use crate::dashboard::{
    DashboardHub, Intervention, MemoryResponse, PluginInfo, SemanticStatus, SessionSnapshot,
    StatusResponse,
};
use crate::Error;

pub type SharedMemory = Arc<Mutex<MemoryStore>>;
pub const MAX_SESSIONS: usize = 32;

pub trait RunnerFactory: Send + Sync + 'static {
    fn create(&self, id: &str, memory: SharedMemory) -> Result<AgentRunner, Error>;
}

#[derive(Debug)]
pub struct ConfigFactory {
    pub stream_responses: bool,
    pub config_path: PathBuf,
    pub working_directory: PathBuf,
    pub allow_shell: bool,
}

impl ConfigFactory {
    pub fn new(config_path: impl Into<PathBuf>, working_directory: impl Into<PathBuf>) -> Self {
        Self {
            stream_responses: false,
            config_path: config_path.into(),
            working_directory: working_directory.into(),
            allow_shell: false,
        }
    }

    fn tools(&self, memory: SharedMemory, coding_session: bool) -> Result<ToolRegistry, Error> {
        let mut tools = ToolRegistry::new();
        // I require operator opt-in for shell execution because ADR-004 makes trusted components authorize capabilities.
        if self.allow_shell {
            #[cfg(unix)]
            tools.register(Arc::new(BashTool {
                working_directory: self.working_directory.clone(),
                timeout: Duration::from_secs(30),
                output_byte_cap: 64 * 1024,
            }))?;
            #[cfg(windows)]
            tools.register(Arc::new(PowerShellTool::new(&self.working_directory)))?;
        }
        tools.register(Arc::new(MemoryReadTool::new(memory)))?;
        if coding_session {
            tools.register(Arc::new(RepoMapTool::new(&self.working_directory)))?;
        }
        Ok(tools)
    }

    fn session_tools(
        &self,
        memory: SharedMemory,
        config: &AgentConfig,
    ) -> Result<Arc<ToolRegistry>, Error> {
        let tools = Arc::new(self.tools(memory, config.coding_session)?);
        let manager =
            PluginManager::new(&self.working_directory, config.plugin_permissions.clone());
        if config.allow_creator_mode {
            tools.register_creator_tools(manager.clone())?;
        }
        tools.register_plugins(&manager)?;
        Ok(tools)
    }
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
        let tools = self.session_tools(memory.clone(), &config)?;
        let mut runner = AgentRunner::from_config(config, tools, memory, id)?;
        runner.set_streaming(self.stream_responses);
        Ok(runner)
    }
}

struct Session {
    control: lain_agent::control::AgentControl,
    tools: Arc<ToolRegistry>,
    runner: AsyncMutex<AgentRunner>,
    canceller: Canceller,
    created: u64,
}

pub struct DaemonHandler {
    pub dashboard: DashboardHub,
    memory: SharedMemory,
    factory: Arc<dyn RunnerFactory>,
    sessions: RwLock<HashMap<String, Arc<Session>>>,
    next_session: AtomicU64,
}

impl std::fmt::Debug for DaemonHandler {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DaemonHandler").finish_non_exhaustive()
    }
}

impl DaemonHandler {
    pub fn new(memory: SharedMemory, factory: Arc<dyn RunnerFactory>) -> Self {
        Self {
            dashboard: DashboardHub::default(),
            memory,
            factory,
            sessions: RwLock::new(HashMap::new()),
            next_session: AtomicU64::new(0),
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
                let evict = if sessions.len() >= MAX_SESSIONS {
                    Some(
                        sessions
                            .iter()
                            .filter(|(_, session)| session.runner.try_lock().is_ok())
                            .min_by_key(|(_, session)| session.created)
                            .map(|(id, _)| id.clone())
                            .ok_or_else(|| {
                                Error::failure("SESSION_LIMIT", "All 32 sessions are running")
                            })?,
                    )
                } else {
                    None
                };
                let runner = self.factory.create(&id, self.memory.clone())?;
                let canceller = runner.canceller();
                let control = runner.control();
                let tools = runner.tool_registry();
                if let Some(evict) = evict {
                    sessions.remove(&evict);
                    self.dashboard.remove(&evict);
                }
                self.dashboard.insert(SessionSnapshot {
                    session_id: id.clone(),
                    model: runner.config().model.clone(),
                    status: "idle".into(),
                    token_limit: runner.config().budget.max_total_tokens,
                    context_window: runner.config().context_window_tokens,
                    ..SessionSnapshot::default()
                });
                sessions.insert(
                    id.clone(),
                    Arc::new(Session {
                        control,
                        tools,
                        runner: AsyncMutex::new(runner),
                        canceller,
                        created: self.next_session.fetch_add(1, Ordering::Relaxed),
                    }),
                );
                drop(sessions);
                events
                    .send(Event::SessionStarted { session_id: id })
                    .await?;
            }
            Command::SendMessage { session_id, text } => self.run(session_id, text, events).await?,
            Command::CancelTurn { session_id } => {
                let session = self.session(&session_id).await?;
                let status = match session.runner.try_lock() {
                    Ok(_) => "idle: nothing to cancel",
                    Err(_) => {
                        session.canceller.cancel();
                        "cancelling"
                    }
                };
                events
                    .send(Event::Status {
                        session_id: Some(session_id),
                        status: status.into(),
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
        let sessions = self.sessions.read().await;
        let session = sessions
            .get(&id)
            .cloned()
            .ok_or_else(|| Error::failure("SESSION_NOT_FOUND", &id))?;
        let mut runner = session
            .runner
            .try_lock()
            .map_err(|_| Error::failure("SESSION_BUSY", &id))?;
        drop(sessions);
        let mut source = runner.subscribe();
        let result = {
            let run = runner.run(text);
            tokio::pin!(run);
            loop {
                tokio::select! {
                    biased;
                    event = source.recv() => {
                        if let Ok(event) = &event { self.dashboard.publish(&id, event.clone()); }
                        forward_agent_event(&id, event, events).await?;
                    }
                    result = &mut run => break result,
                    _ = events.closed() => { session.canceller.cancel(); break run.await; }
                }
            }
        };
        if matches!(runner.state().status, AgentStatus::Terminated(_)) {
            self.sessions.write().await.remove(&id);
        }
        while let Ok(event) = source.try_recv() {
            self.dashboard.publish(&id, event.clone());
            if let Some(event) = map_agent_event(&id, event) {
                events.send(event).await?;
            }
        }
        if let Err(error) = result {
            self.dashboard.publish(
                &id,
                AgentEvent::ErrorTripped {
                    code: error.code().into(),
                    message: error.to_string(),
                },
            );
            events.send(Error::from(error).into_event()).await?;
        }
        if runner.state().inputs > 0
            && matches!(
                runner.state().status,
                AgentStatus::AwaitingInput | AgentStatus::Terminated(_)
            )
        {
            match runner.reflect_and_compact(&id).await {
                Ok(reflection) => {
                    self.dashboard.publish(
                        &id,
                        AgentEvent::ReflectionGenerated {
                            summary: format!(
                                "{} turns, {} tool calls",
                                reflection.turns, reflection.tool_calls
                            ),
                            rules: reflection.rules.clone(),
                        },
                    );
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
                Err(error) => events.send(Error::from(error).into_event()).await?,
            }
        }
        let reason = if runner.state().status == AgentStatus::AwaitingInput {
            "completed".into()
        } else {
            serde_json::to_string(&runner.state().status)?
        };
        self.dashboard.publish(
            &id,
            AgentEvent::SessionCompleted {
                reason: reason.clone(),
            },
        );
        events
            .send(Event::SessionCompleted {
                session_id: id,
                reason,
                scratchpad: Some(runner.state().scratchpad.plan.clone()),
            })
            .await?;
        Ok(())
    }

    pub async fn dashboard_status(&self) -> StatusResponse {
        let mut status = self.dashboard.status();
        let sessions = self.sessions.read().await;
        for snapshot in &mut status.sessions {
            if let Some(session) = sessions.get(&snapshot.session_id) {
                snapshot.control = session.control.snapshot();
                if snapshot.control.paused {
                    snapshot.status = "paused".into();
                }
                if snapshot.control.pending_call.is_some() {
                    snapshot.status = "approval_required".into();
                }
            }
        }
        status
    }

    pub fn dashboard_memory(&self) -> Result<MemoryResponse, Error> {
        let store = self
            .memory
            .lock()
            .map_err(|_| Error::failure("MEMORY_LOCK", "Memory lock poisoned"))?;
        Ok(MemoryResponse {
            episodic: store
                .recent_episodes(None, 50)?
                .into_iter()
                .map(|r| format!("{}: {}", r.title, r.content))
                .collect(),
            procedural: store.recent_procedural_rules(None, 50)?,
            semantic: SemanticStatus {
                backend: "sqlite_fts5".into(),
                embeddings_available: false,
            },
        })
    }

    pub async fn dashboard_plugins(&self) -> Vec<PluginInfo> {
        let sessions = self.sessions.read().await;
        sessions
            .iter()
            .flat_map(|(id, session)| {
                session
                    .tools
                    .definitions()
                    .into_iter()
                    .map(|tool| PluginInfo {
                        session_id: id.clone(),
                        name: tool.name,
                        description: tool.description,
                        parameters: tool.parameters,
                    })
            })
            .collect()
    }

    pub async fn intervene(&self, command: Intervention) -> Result<(), Error> {
        let session = self.session(command.session_id()).await?;
        let accepted = match command {
            Intervention::Pause { .. } => {
                session.control.pause(true);
                true
            }
            Intervention::Resume { .. } => {
                session.control.pause(false);
                true
            }
            Intervention::Cancel { .. } => {
                if session.runner.try_lock().is_err() {
                    session.canceller.cancel();
                }
                true
            }
            Intervention::Intercept { enabled, .. } => {
                session.control.intercept(enabled);
                true
            }
            Intervention::Steer { text, .. } => session.control.steer(text),
            Intervention::Approve { call_id, .. } => session.control.decide(&call_id, true),
            Intervention::Deny { call_id, .. } => session.control.decide(&call_id, false),
        };
        if !accepted {
            return Err(Error::failure(
                "INTERVENTION_REJECTED",
                "Stale approval, empty steering, or steering queue full",
            ));
        }
        Ok(())
    }
}

async fn forward_agent_event(
    id: &str,
    event: Result<AgentEvent, broadcast::error::RecvError>,
    events: &EventSink,
) -> Result<(), Error> {
    let event = match event {
        Ok(event) => event,
        Err(broadcast::error::RecvError::Lagged(_)) => return Ok(()),
        Err(error) => return Err(Error::failure("AGENT_EVENTS_LOST", error)),
    };
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
                let _ = events.send(error.into_event()).await;
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
    fn shell_tools_require_operator_opt_in() -> Result<(), Error> {
        let memory = Arc::new(Mutex::new(MemoryStore::open(":memory:")?));
        let mut factory = ConfigFactory::new("unused.json", ".");
        let definitions = factory.tools(memory.clone(), false)?.definitions();
        assert_eq!(definitions.len(), 1);
        assert!(definitions.iter().all(|tool| tool.name == "memory_read"));
        factory.allow_shell = true;
        let definitions = factory.tools(memory, false)?.definitions();
        assert_eq!(definitions.len(), 2);
        assert!(definitions
            .iter()
            .any(|tool| matches!(tool.name.as_str(), "bash" | "powershell")));
        Ok(())
    }

    #[test]
    fn coding_mode_registers_repo_map_without_granting_shell_access() -> Result<(), Error> {
        let memory = Arc::new(Mutex::new(MemoryStore::open(":memory:")?));
        let factory = ConfigFactory::new("unused.json", ".");
        let names: Vec<_> = factory
            .tools(memory, true)?
            .definitions()
            .into_iter()
            .map(|tool| tool.name)
            .collect();
        assert_eq!(names, ["memory_read", "repo_map"]);
        Ok(())
    }

    #[tokio::test]
    async fn creator_mode_can_be_disabled_and_has_no_implicit_capabilities() -> Result<(), Error> {
        let memory = Arc::new(Mutex::new(MemoryStore::open(":memory:")?));
        let factory = ConfigFactory::new("unused.json", ".");
        let mut config = AgentConfig::new(
            lain_agent::ProviderSelection::OpenAiCompatible {
                base_url: "http://127.0.0.1:9/v1".into(),
                api_key_env: None,
            },
            "test",
        );
        assert_eq!(config.allow_creator_mode, cfg!(debug_assertions));
        config.allow_creator_mode = false;
        let tools = factory.session_tools(memory.clone(), &config)?;
        assert!(!tools.contains("create_tool"));
        assert!(!tools.contains("test_tool"));
        config.allow_creator_mode = true;
        let tools = factory.session_tools(memory, &config)?;
        assert!(tools.contains("create_tool"));
        let error = tools
            .dispatch(
                "test_tool",
                json!({
                    "name":"example", "description":"Example", "interpreter":"python",
                    "source":"print('not executed')", "parameters":{"type":"object"}, "test_args":{}
                }),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code(), "TOOL_PERMISSION_DENIED");
        Ok(())
    }

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
