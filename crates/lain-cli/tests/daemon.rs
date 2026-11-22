use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::Duration,
};

use async_trait::async_trait;
use futures::stream::BoxStream;
use lain_agent::{AgentConfig, AgentRunner, ProviderSelection};
use lain_cli::{
    daemon::{ConfigFactory, DaemonHandler, RunnerFactory, SharedMemory},
    dashboard::Intervention,
    Error,
};
use lain_core::{
    provider::{
        CompletionRequest, CompletionResponse, Message, ModelProvider, Role, Token, ToolCall,
    },
    tools::{MemoryReadTool, ToolRegistry},
    CoreError,
};
use lain_ipc::{Command, Endpoint, Event, IpcClient, IpcServer};
use lain_memory::{MemoryInput, MemoryStore};
use tokio::{
    sync::{watch, Notify},
    time::timeout,
};

type TestResult = Result<(), Box<dyn std::error::Error>>;

fn endpoint(directory: &tempfile::TempDir) -> Endpoint {
    #[cfg(unix)]
    let path = directory.path().join("ipc.sock");
    #[cfg(windows)]
    let path = std::path::PathBuf::from(format!(
        r"\\.\pipe\lain-cli-{}-{}",
        std::process::id(),
        directory
            .path()
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
    ));
    Endpoint(path)
}

fn memory(directory: &tempfile::TempDir) -> Result<SharedMemory, Error> {
    let mut store = MemoryStore::open(directory.path().join("memory.db"))?;
    store.remember(MemoryInput {
        id: Some("prior/input/1".into()),
        title: "fruit".into(),
        content: "apple".into(),
        trust: Some("untrusted".into()),
        source: "lain-agent:prior".into(),
        ..MemoryInput::default()
    })?;
    store.replace_procedural_rules("prior", "fruit", &["Check fruit before answering.".into()])?;
    Ok(Arc::new(Mutex::new(store)))
}

#[tokio::test]
async fn ping_status_memory_and_missing_config() -> TestResult {
    timeout(Duration::from_secs(10), async {
        let directory = tempfile::tempdir()?;
        let endpoint = endpoint(&directory);
        let handler = Arc::new(DaemonHandler::new(memory(&directory)?, Arc::new(ConfigFactory::new(
            directory.path().join("missing.json"), directory.path(),
        ))));
        let (stop, receiver) = watch::channel(false);
        let server = tokio::spawn(IpcServer::bind(&endpoint)?.serve(handler, receiver));
        let mut client = IpcClient::connect(&endpoint).await?;
        assert!(matches!(client.request(Command::Ping).await?.as_slice(), [Event::Pong { server_version: 1 }]));
        assert!(matches!(client.request(Command::GetStatus { session_id: None }).await?.as_slice(), [Event::Status { status, scratchpad: None, daemon:Some(info),.. }] if status.starts_with("ready") && info.pid==std::process::id() && info.name=="lain" && info.uptime_seconds<10));
        let records = client.request(Command::InspectMemory { session_id: None, limit: Some(5) }).await?;
        assert!(matches!(records.as_slice(), [Event::Memory { episodic, procedural }] if episodic.iter().any(|s| s.contains("apple")) && procedural.len() == 1));
        assert!(matches!(client.request(Command::InspectMemory { session_id: Some("missing".into()), limit: None }).await?.as_slice(),
            [Event::Memory { episodic, procedural }] if episodic.is_empty() && procedural.is_empty()));
        assert!(matches!(client.request(Command::InspectMemory { session_id: None, limit: Some(0) }).await?.as_slice(), [Event::Error { .. }]));
        let missing = client.request(Command::StartSession { session_id: None }).await?;
        assert!(matches!(missing.as_slice(), [Event::Error { code, message }]
            if code == "CONFIG_NOT_FOUND" && message.contains("missing.json") && !message.contains("CONFIG_NOT_FOUND")));
        assert!(matches!(client.request(Command::Ping).await?.as_slice(), [Event::Pong { .. }]));
        client.close().await?;
        stop.send(true)?;
        server.await??;
        Ok::<(), Box<dyn std::error::Error>>(())
    }).await?
}

struct ScriptedProvider {
    messages: Mutex<VecDeque<Message>>,
    started: Arc<Notify>,
    pending: bool,
}

#[tokio::test]
async fn rules_inspection_omits_oversized_transcripts() -> TestResult {
    timeout(Duration::from_secs(10), async {
        let directory = tempfile::tempdir()?;
        let endpoint = endpoint(&directory);
        let memory = memory(&directory)?;
        {
            let mut store = memory.lock().map_err(|_| "poisoned memory")?;
            for i in 0..2 {
                store.remember(MemoryInput {
                    title: format!("long episode {i}"),
                    content: "x".repeat(600_000),
                    trust: Some("untrusted".into()),
                    source: "lain-agent:prior".into(),
                    ..MemoryInput::default()
                })?;
            }
            assert!(store.recent_episodes(None, 20)?.iter().map(|r| r.content.len()).sum::<usize>() > lain_ipc::MAX_FRAME_SIZE);
        }
        let handler = Arc::new(DaemonHandler::new(memory, Arc::new(ConfigFactory::new(
            directory.path().join("missing.json"), directory.path(),
        ))));
        let (stop, receiver) = watch::channel(false);
        let server = tokio::spawn(IpcServer::bind(&endpoint)?.serve(handler, receiver));
        let mut client = IpcClient::connect(&endpoint).await?;
        let command = serde_json::from_value(serde_json::json!({"type":"inspect_rules", "session_id":null, "limit":20}))?;
        let events = client.request(command).await?;
        assert!(matches!(events.as_slice(), [Event::Memory { episodic, procedural }]
            if episodic.is_empty() && procedural == &["Check fruit before answering."]));
        let command = serde_json::from_value(serde_json::json!({"type":"inspect_rules", "session_id":"missing", "limit":20}))?;
        assert!(matches!(client.request(command).await?.as_slice(), [Event::Memory { episodic, procedural }]
            if episodic.is_empty() && procedural.is_empty()));
        let command = serde_json::from_value(serde_json::json!({"type":"inspect_rules", "session_id":null, "limit":0}))?;
        assert!(matches!(client.request(command).await?.as_slice(), [Event::Error { .. }]));
        assert!(matches!(client.request(Command::Ping).await?.as_slice(), [Event::Pong { .. }]));
        client.close().await?;
        stop.send(true)?;
        server.await??;
        Ok::<(), Box<dyn std::error::Error>>(())
    }).await?
}

#[async_trait]
impl ModelProvider for ScriptedProvider {
    async fn complete(&self, _: CompletionRequest) -> Result<CompletionResponse, CoreError> {
        self.started.notify_one();
        if self.pending {
            std::future::pending::<()>().await;
        }
        let message = self
            .messages
            .lock()
            .map_err(|_| CoreError::Protocol("lock".into()))?
            .pop_front()
            .ok_or_else(|| CoreError::Protocol("script exhausted".into()))?;
        Ok(CompletionResponse {
            message,
            finish_reason: None,
            usage: None,
        })
    }

    async fn stream(
        &self,
        _: CompletionRequest,
    ) -> Result<BoxStream<'static, Result<Token, CoreError>>, CoreError> {
        Err(CoreError::Protocol("unused".into()))
    }
}

struct ScriptedFactory(Arc<Notify>);

#[tokio::test]
async fn a_dropped_turn_settles_before_the_next_client_runs() -> TestResult {
    timeout(Duration::from_secs(10),async {
        let directory=tempfile::tempdir()?;let endpoint=endpoint(&directory);
        let started=Arc::new(Notify::new());
        let handler=Arc::new(DaemonHandler::new(memory(&directory)?,Arc::new(ScriptedFactory(started.clone()))));
        let (stop,receiver)=watch::channel(false);
        let server=tokio::spawn(IpcServer::bind(&endpoint)?.serve(handler.clone(),receiver));
        let mut first=IpcClient::connect(&endpoint).await?;
        first.request(Command::StartSession {session_id:Some("pending-drop".into())}).await?;
        first.send(Command::SendMessage {session_id:"pending-drop".into(),text:"wait".into(),stream_deltas:true}).await?;
        started.notified().await;drop(first);
        let mut next=IpcClient::connect(&endpoint).await?;
        loop {
            let replies=next.request(Command::ListSessions).await?;
            if matches!(replies.as_slice(),[Event::Sessions {sessions}] if sessions.iter().all(|s|s.id!="pending-drop")) {break;}
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let status=handler.dashboard_status().await;
        assert!(status.sessions.iter().all(|s|s.session_id!="pending-drop" || s.status!="running"));
        next.request(Command::StartSession {session_id:Some("next".into())}).await?;
        let replies=next.request(Command::SendMessage {session_id:"next".into(),text:"hi".into(),stream_deltas:false}).await?;
        assert!(replies.iter().any(|event|matches!(event,Event::SessionCompleted {reason,..} if reason=="completed")));
        assert!(matches!(next.request(Command::ListSessions).await?.as_slice(),[Event::Sessions {sessions}]
            if sessions.len()==1 && sessions.iter().all(|s|s.status==Some(lain_ipc::SessionStatus::Idle))));
        next.close().await?;stop.send(true)?;server.await??;
        Ok::<(),Box<dyn std::error::Error>>(())
    }).await?
}

#[tokio::test]
async fn read_only_ipc_and_telemetry() -> TestResult {
    timeout(Duration::from_secs(10), async {
        let directory = tempfile::tempdir()?;
        let endpoint = endpoint(&directory);
        let handler = Arc::new(DaemonHandler::new(memory(&directory)?, Arc::new(ScriptedFactory(Arc::new(Notify::new())))));
        let (stop, receiver) = watch::channel(false);
        let server = tokio::spawn(IpcServer::bind(&endpoint)?.serve(handler, receiver));
        let mut client = IpcClient::connect(&endpoint).await?;
        client.request(Command::StartSession { session_id: Some("readonly".into()) }).await?;
        assert!(matches!(client.request(Command::GetTelemetry { session_id: "readonly".into() }).await?.as_slice(),
            [Event::Telemetry { model, tokens_used: 0, .. }] if model == "scripted"));
        let events = client.request(Command::SendReadOnlyMessage { stream_deltas: false, session_id: "readonly".into(), text: "Plan using memory".into() }).await?;
        assert!(events.iter().any(|event| matches!(event, Event::ToolFinished { name, ok: true, .. } if name == "memory_read")));
        assert!(events.iter().any(|event| matches!(event, Event::SessionCompleted { reason, .. } if reason == "completed")));
        assert!(matches!(client.request(Command::GetTelemetry { session_id: "missing".into() }).await?.as_slice(), [Event::Error { code, .. }] if code == "SESSION_NOT_FOUND"));
        client.close().await?;
        stop.send(true)?;
        server.await??;
        Ok::<(), Box<dyn std::error::Error>>(())
    }).await?
}

#[tokio::test]
async fn dashboard_interventions_validate_steering_and_idle_cancel_preserves_session() -> TestResult
{
    timeout(Duration::from_secs(10), async {
        let directory = tempfile::tempdir()?;
        let endpoint = endpoint(&directory);
        let handler = Arc::new(DaemonHandler::new(
            memory(&directory)?,
            Arc::new(ScriptedFactory(Arc::new(Notify::new()))),
        ));
        let (stop, receiver) = watch::channel(false);
        let server = tokio::spawn(IpcServer::bind(&endpoint)?.serve(handler.clone(), receiver));
        let mut client = IpcClient::connect(&endpoint).await?;
        client
            .request(Command::StartSession {
                session_id: Some("s".into()),
            })
            .await?;
        handler
            .intervene(Intervention::Pause {
                session_id: "s".into(),
            })
            .await?;
        assert!(
            handler
                .dashboard_status()
                .await
                .sessions
                .first()
                .ok_or("no session")?
                .control
                .paused
        );
        handler
            .intervene(Intervention::Resume {
                session_id: "s".into(),
            })
            .await?;
        assert!(
            !handler
                .dashboard_status()
                .await
                .sessions
                .first()
                .ok_or("no session")?
                .control
                .paused
        );
        for text in [" ".into(), "x".repeat(8001)] {
            assert_eq!(
                handler
                    .intervene(Intervention::Steer {
                        session_id: "s".into(),
                        text
                    })
                    .await
                    .err()
                    .ok_or("accepted invalid steering")?
                    .code(),
                "INTERVENTION_REJECTED"
            );
        }
        assert_eq!(
            handler
                .intervene(Intervention::Approve {
                    session_id: "s".into(),
                    call_id: "stale".into()
                })
                .await
                .err()
                .ok_or("accepted stale approval")?
                .code(),
            "INTERVENTION_REJECTED"
        );
        handler
            .intervene(Intervention::Steer {
                session_id: "s".into(),
                text: "continue".into(),
            })
            .await?;
        handler
            .intervene(Intervention::Cancel {
                session_id: "s".into(),
            })
            .await?;
        let events = client
            .request(Command::SendMessage {
                stream_deltas: false,
                session_id: "s".into(),
                text: "hello".into(),
            })
            .await?;
        assert!(
            events
                .iter()
                .any(|event| matches!(event, Event::StreamToken { text, .. } if text == "Done.")),
            "{events:?}"
        );
        client.close().await?;
        stop.send(true)?;
        server.await??;
        Ok::<(), Box<dyn std::error::Error>>(())
    })
    .await?
}

#[tokio::test]
async fn sessions_are_bounded_and_terminated_sessions_are_removed() -> TestResult {
    timeout(Duration::from_secs(15), async {
        let directory = tempfile::tempdir()?;
        let endpoint = endpoint(&directory);
        let started = Arc::new(Notify::new());
        let handler = Arc::new(DaemonHandler::new(memory(&directory)?, Arc::new(ScriptedFactory(started.clone()))));
        let (stop, receiver) = watch::channel(false);
        let server = tokio::spawn(IpcServer::bind(&endpoint)?.serve(handler, receiver));
        let mut client = IpcClient::connect(&endpoint).await?;
        for index in 0..=32 {
            assert!(matches!(client.request(Command::StartSession { session_id: Some(format!("pending-{index}")) }).await?.as_slice(), [Event::SessionStarted { .. }]));
        }
        assert!(matches!(client.request(Command::GetStatus { session_id: Some("pending-0".into()) }).await?.as_slice(), [Event::Error { code, .. }] if code == "SESSION_NOT_FOUND"));
        assert!(matches!(client.request(Command::GetStatus { session_id: None }).await?.as_slice(), [Event::Status { status, .. }] if status == "ready (32 sessions)"));
        for index in 1..=32 {
            client.send(Command::SendMessage { stream_deltas: false, session_id: format!("pending-{index}"), text: "wait".into() }).await?;
            started.notified().await;
        }
        assert!(matches!(client.request(Command::StartSession { session_id: Some("overflow".into()) }).await?.as_slice(), [Event::Error { code, .. }] if code == "SESSION_LIMIT"));
        for index in 1..=32 {
            client.request(Command::CancelTurn { session_id: format!("pending-{index}") }).await?;
        }
        let mut completed = 0;
        while completed < 32 {
            if matches!(client.recv().await?.ok_or("closed")?.1, Event::SessionCompleted { .. }) { completed += 1; }
        }
        assert!(matches!(client.request(Command::GetStatus { session_id: None }).await?.as_slice(), [Event::Status { status, .. }] if status == "ready (0 sessions)"));
        client.close().await?;
        stop.send(true)?;
        server.await??;
        Ok::<(), Box<dyn std::error::Error>>(())
    }).await?
}

impl RunnerFactory for ScriptedFactory {
    fn create(&self, id: &str, memory: SharedMemory) -> Result<AgentRunner, Error> {
        let mut tools = ToolRegistry::new();
        tools.register(Arc::new(MemoryReadTool::new(memory.clone())))?;
        let mut tool_call = Message::text(Role::Assistant, "Checking memory.");
        tool_call.tool_calls.push(ToolCall {
            id: "call-1".into(),
            name: "memory_read".into(),
            arguments: serde_json::json!({"query":"fruit"}),
        });
        let provider = Arc::new(ScriptedProvider {
            messages: Mutex::new(VecDeque::from([
                tool_call,
                Message::text(Role::Assistant, "Done."),
            ])),
            started: self.0.clone(),
            pending: id.starts_with("pending"),
        });
        let config = AgentConfig::new(
            ProviderSelection::OpenAiCompatible {
                base_url: "http://127.0.0.1:9/v1".into(),
                api_key_env: None,
            },
            "scripted",
        );
        Ok(AgentRunner::new(
            config,
            provider,
            Arc::new(tools),
            memory,
            id,
        )?)
    }
}

#[tokio::test]
async fn scripted_run_event_order_status_and_cancel() -> TestResult {
    timeout(Duration::from_secs(10), async {
        let directory = tempfile::tempdir()?;
        let endpoint = endpoint(&directory);
        let started = Arc::new(Notify::new());
        let handler = Arc::new(DaemonHandler::new(memory(&directory)?, Arc::new(ScriptedFactory(started.clone()))));
        let (stop, receiver) = watch::channel(false);
        let server = tokio::spawn(IpcServer::bind(&endpoint)?.serve(handler, receiver));
        let mut client = IpcClient::connect(&endpoint).await?;
        assert!(matches!(client.request(Command::StartSession { session_id: Some("s".into()) }).await?.as_slice(), [Event::SessionStarted { .. }]));
        assert!(matches!(client.request(Command::CancelTurn { session_id: "s".into() }).await?.as_slice(),
            [Event::Status { status, .. }] if status == "idle: nothing to cancel"));
        let events = client.request(Command::SendMessage { stream_deltas: false, session_id: "s".into(), text: "hi".into() }).await?;
        let labels: Vec<_> = events.iter().map(|event| match event {
            Event::StreamToken { .. } => "text", Event::ToolStarted { .. } => "tool_start", Event::ToolFinished { ok: true, .. } => "tool_end",
            Event::ReflectionGenerated { .. } => "reflection", Event::SessionCompleted { reason, scratchpad: Some(_), .. } if reason == "completed" => "completed", _ => "unexpected",
        }).collect();
        assert_eq!(labels, ["text", "tool_start", "tool_end", "text", "reflection", "completed"]);
        assert!(matches!(client.request(Command::ListSessions).await?.as_slice(), [Event::Sessions {sessions}]
            if sessions.iter().any(|s| s.id == "s" && s.turn_count == 2 && s.model.as_deref() == Some("scripted") && s.mode.is_none() && s.status==Some(lain_ipc::SessionStatus::Idle))));
        assert!(matches!(client.request(Command::GetStatus { session_id: Some("s".into()) }).await?.as_slice(), [Event::Status { scratchpad: Some(_), .. }]));
        assert!(matches!(client.request(Command::StartSession { session_id: Some("s".into()) }).await?.as_slice(), [Event::Error { code, .. }] if code == "SESSION_EXISTS"));
        client.request(Command::StartSession { session_id: Some("pending".into()) }).await?;
        let _ = started.notified().await;
        let pending = client.send(Command::SendMessage { stream_deltas: false, session_id: "pending".into(), text: "hi".into() }).await?;
        started.notified().await;
        assert!(matches!(client.request(Command::GetStatus { session_id: Some("pending".into()) }).await?.as_slice(), [Event::Status { status, .. }] if status == "running"));
        let rejected=client.request(Command::SendMessage {stream_deltas:false,session_id:"pending".into(),text:"again".into()}).await?;
        assert!(matches!(rejected.as_slice(), [Event::Error { code, .. }] if code == "SESSION_BUSY"));
        assert!(matches!(client.request(Command::ListSessions).await?.as_slice(), [Event::Sessions {sessions}]
            if sessions.iter().any(|s| s.id == "pending" && s.turn_count == 1 && s.status==Some(lain_ipc::SessionStatus::Running))));
        assert!(matches!(client.request(Command::ListTools {session_id:"pending".into()}).await?.as_slice(), [Event::Tools {..}]));
        let proposal = serde_json::from_value(serde_json::json!({"name":"blocked", "description":"Busy", "parameters":{"type":"object"},
            "interpreter":"python", "source":"pass", "test_args":{}}))?;
        assert!(matches!(client.request(Command::PublishToolProposal {session_id:"pending".into(), mode:lain_ipc::SessionMode::Code, proposal}).await?.as_slice(),
            [Event::Error {code, ..}] if code == "SESSION_BUSY"));
        client.send(Command::CancelTurn { session_id: "pending".into() }).await?;
        loop {
            let (id, event) = client.recv().await?.ok_or("connection closed")?;
            if id == pending {
                assert!(!matches!(event, Event::Error { .. }), "{event:?}");
                if let Event::SessionCompleted { reason, .. } = event { assert!(reason.contains("cancelled")); break; }
            }
        }
        client.close().await?;
        stop.send(true)?;
        server.await??;
        Ok::<(), Box<dyn std::error::Error>>(())
    }).await?
}
