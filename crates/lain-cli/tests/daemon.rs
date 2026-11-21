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
        let handler = Arc::new(DaemonHandler::new(memory(&directory)?, Arc::new(ConfigFactory {
            config_path: directory.path().join("missing.json"), working_directory: directory.path().into(),
        })));
        let (stop, receiver) = watch::channel(false);
        let server = tokio::spawn(IpcServer::bind(&endpoint)?.serve(handler, receiver));
        let mut client = IpcClient::connect(&endpoint).await?;
        assert!(matches!(client.request(Command::Ping).await?.as_slice(), [Event::Pong { server_version: 1 }]));
        assert!(matches!(client.request(Command::GetStatus { session_id: None }).await?.as_slice(), [Event::Status { status, scratchpad: None, .. }] if status.starts_with("ready")));
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
            pending: id == "pending",
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
        let events = client.request(Command::SendMessage { session_id: "s".into(), text: "hi".into() }).await?;
        let labels: Vec<_> = events.iter().map(|event| match event {
            Event::StreamToken { .. } => "text", Event::ToolStarted { .. } => "tool_start", Event::ToolFinished { ok: true, .. } => "tool_end",
            Event::ReflectionGenerated { .. } => "reflection", Event::SessionCompleted { reason, scratchpad: Some(_), .. } if reason == "completed" => "completed", _ => "unexpected",
        }).collect();
        assert_eq!(labels, ["text", "tool_start", "tool_end", "text", "reflection", "completed"]);
        assert!(matches!(client.request(Command::GetStatus { session_id: Some("s".into()) }).await?.as_slice(), [Event::Status { scratchpad: Some(_), .. }]));
        assert!(matches!(client.request(Command::StartSession { session_id: Some("s".into()) }).await?.as_slice(), [Event::Error { code, .. }] if code == "SESSION_EXISTS"));
        client.request(Command::StartSession { session_id: Some("pending".into()) }).await?;
        let _ = started.notified().await;
        let pending = client.send(Command::SendMessage { session_id: "pending".into(), text: "hi".into() }).await?;
        started.notified().await;
        assert!(matches!(client.request(Command::GetStatus { session_id: Some("pending".into()) }).await?.as_slice(), [Event::Status { status, .. }] if status == "running"));
        assert!(matches!(client.request(Command::SendMessage { session_id: "pending".into(), text: "again".into() }).await?.as_slice(), [Event::Error { code, .. }] if code == "SESSION_BUSY"));
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
