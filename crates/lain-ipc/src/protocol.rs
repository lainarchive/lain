use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use lain_plugin::{
    manifest::{Capability, ScriptProposal},
    ManifestEntry, ScriptExecution,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionMode {
    Architect,
    Code,
    Ask,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ToolSource {
    Builtin,
    Plugin {
        manifest_name: String,
        manifest_path: Option<PathBuf>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PermissionGrant {
    pub capability: Capability,
    pub granted: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ActiveTool {
    pub name: String,
    pub description: String,
    pub parameters: Value,
    pub source: ToolSource,
    pub permissions: Vec<PermissionGrant>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Running,
    Idle,
    Busy,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DaemonInfo {
    pub name: String,
    pub pid: u32,
    pub uptime_seconds: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionInfo {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<SessionMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub turn_count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<SessionStatus>,
}

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_FRAME_SIZE: usize = 1024 * 1024;
pub const EVENT_CAPACITY: usize = 256;
pub type RequestId = u64;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClientFrame {
    pub version: u32,
    pub id: RequestId,
    pub command: Command,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ServerFrame {
    pub version: u32,
    pub id: RequestId,
    pub event: Event,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[non_exhaustive]
pub enum Command {
    ListTools {
        session_id: String,
    },
    ListPlugins,
    TestToolProposal {
        session_id: String,
        proposal: ScriptProposal,
    },
    PublishToolProposal {
        session_id: String,
        proposal: ScriptProposal,
        mode: SessionMode,
    },
    ListSessions,
    Ping,
    StartSession {
        session_id: Option<String>,
    },
    SendMessage {
        session_id: String,
        text: String,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        stream_deltas: bool,
    },
    SendReadOnlyMessage {
        session_id: String,
        text: String,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        stream_deltas: bool,
    },
    GetTelemetry {
        session_id: String,
    },
    CancelTurn {
        session_id: String,
    },
    GetStatus {
        session_id: Option<String>,
    },
    InspectMemory {
        session_id: Option<String>,
        limit: Option<u32>,
    },
    InspectRules {
        session_id: Option<String>,
        limit: Option<u32>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[non_exhaustive]
pub enum Event {
    Tools {
        session_id: String,
        allow_creator_mode: bool,
        tools: Vec<ActiveTool>,
    },
    Plugins {
        plugins: Vec<ManifestEntry>,
    },
    ToolProposalResult {
        session_id: String,
        execution: ScriptExecution,
        written_paths: Vec<PathBuf>,
    },
    Sessions {
        sessions: Vec<SessionInfo>,
    },
    Telemetry {
        session_id: String,
        model: String,
        context_tokens: usize,
        context_window: usize,
        tokens_used: u64,
        scratchpad: String,
    },
    Pong {
        server_version: u32,
    },
    SessionStarted {
        session_id: String,
    },
    StreamToken {
        session_id: String,
        text: String,
    },
    TokenDelta {
        session_id: String,
        turn: u32,
        text: String,
    },
    ToolStarted {
        session_id: String,
        call_id: String,
        name: String,
        arguments: Value,
    },
    ToolFinished {
        session_id: String,
        call_id: String,
        name: String,
        ok: bool,
        summary: String,
    },
    ReflectionGenerated {
        session_id: String,
        summary: String,
        rules: Vec<String>,
    },
    SessionCompleted {
        session_id: String,
        reason: String,
        scratchpad: Option<String>,
    },
    Status {
        session_id: Option<String>,
        status: String,
        scratchpad: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        daemon: Option<DaemonInfo>,
    },
    Memory {
        episodic: Vec<String>,
        procedural: Vec<String>,
    },
    Error {
        code: String,
        message: String,
    },
}

impl Event {
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            Self::Tools { .. }
                | Self::Plugins { .. }
                | Self::ToolProposalResult { .. }
                | Self::Sessions { .. }
                | Self::Pong { .. }
                | Self::Telemetry { .. }
                | Self::SessionStarted { .. }
                | Self::SessionCompleted { .. }
                | Self::Status { .. }
                | Self::Memory { .. }
                | Self::Error { .. }
        )
    }

    pub(crate) fn error(code: &str, message: impl ToString) -> Self {
        Self::Error {
            code: code.into(),
            message: message.to_string(),
        }
    }
}

impl ServerFrame {
    pub(crate) fn new(id: RequestId, event: Event) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            id,
            event,
        }
    }
}

pub(crate) fn decode_client(bytes: &[u8]) -> Result<ClientFrame, Box<ServerFrame>> {
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|error| ServerFrame::new(0, Event::error("IPC_INVALID_JSON", error)))?;
    let id = value.get("id").and_then(Value::as_u64).unwrap_or(0);
    if value.get("version").and_then(Value::as_u64) != Some(u64::from(PROTOCOL_VERSION)) {
        return Err(Box::new(ServerFrame::new(
            id,
            Event::error("IPC_VERSION_MISMATCH", "Unsupported protocol version"),
        )));
    }
    serde_json::from_value(value).map_err(|error| {
        Box::new(ServerFrame::new(
            id,
            Event::error("IPC_INVALID_FRAME", error),
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commands_roundtrip() -> Result<(), Box<dyn std::error::Error>> {
        for kind in ["send_message", "send_read_only_message"] {
            let legacy = serde_json::json!({"type":kind,"session_id":"s","text":"hello"});
            let command: Command = serde_json::from_value(legacy.clone())?;
            assert_eq!(serde_json::to_value(command)?, legacy);
            let streaming = serde_json::json!({"type":kind,"session_id":"s","text":"hello","stream_deltas":true});
            let command: Command = serde_json::from_value(streaming.clone())?;
            assert_eq!(serde_json::to_value(command)?, streaming);
        }
        let commands = vec![
            Command::Ping,
            Command::SendReadOnlyMessage {
                stream_deltas: false,
                session_id: "s".into(),
                text: "plan".into(),
            },
            Command::GetTelemetry {
                session_id: "s".into(),
            },
            Command::StartSession { session_id: None },
            Command::StartSession {
                session_id: Some("s".into()),
            },
            Command::SendMessage {
                stream_deltas: false,
                session_id: "s".into(),
                text: "hello\nworld".into(),
            },
            Command::CancelTurn {
                session_id: "s".into(),
            },
            Command::GetStatus { session_id: None },
            Command::GetStatus {
                session_id: Some("s".into()),
            },
            Command::InspectMemory {
                session_id: None,
                limit: None,
            },
            Command::InspectMemory {
                session_id: Some("s".into()),
                limit: Some(3),
            },
        ];
        for command in commands {
            let frame = ClientFrame {
                version: PROTOCOL_VERSION,
                id: 42,
                command,
            };
            let bytes = serde_json::to_vec(&frame)?;
            assert_eq!(serde_json::from_slice::<ClientFrame>(&bytes)?, frame);
            assert_eq!(decode_client(&bytes), Ok(frame));
        }
        Ok(())
    }

    #[test]
    fn events_roundtrip() -> Result<(), Box<dyn std::error::Error>> {
        let events = vec![
            Event::TokenDelta {
                session_id: "s".into(),
                turn: 1,
                text: "part".into(),
            },
            Event::Pong {
                server_version: PROTOCOL_VERSION,
            },
            Event::SessionStarted {
                session_id: "s".into(),
            },
            Event::StreamToken {
                session_id: "s".into(),
                text: "\n\"".into(),
            },
            Event::ToolStarted {
                session_id: "s".into(),
                call_id: "c".into(),
                name: "tool".into(),
                arguments: serde_json::json!({"arg": 3}),
            },
            Event::ToolFinished {
                session_id: "s".into(),
                call_id: "c".into(),
                name: "tool".into(),
                ok: false,
                summary: "failed".into(),
            },
            Event::ReflectionGenerated {
                session_id: "s".into(),
                summary: "summary".into(),
                rules: vec!["rule".into()],
            },
            Event::SessionCompleted {
                session_id: "s".into(),
                reason: "done".into(),
                scratchpad: Some("notes".into()),
            },
            Event::SessionCompleted {
                session_id: "s".into(),
                reason: "done".into(),
                scratchpad: None,
            },
            Event::Status {
                session_id: Some("s".into()),
                status: "idle".into(),
                scratchpad: Some("notes".into()),
                daemon: None,
            },
            Event::Status {
                session_id: None,
                status: "idle".into(),
                scratchpad: None,
                daemon: Some(DaemonInfo {
                    name: "lain".into(),
                    pid: 42,
                    uptime_seconds: 60,
                }),
            },
            Event::Memory {
                episodic: vec!["episode".into()],
                procedural: vec!["rule".into()],
            },
            Event::Memory {
                episodic: vec![],
                procedural: vec![],
            },
            Event::Telemetry {
                session_id: "s".into(),
                model: "local".into(),
                context_tokens: 42,
                context_window: 128,
                tokens_used: 100,
                scratchpad: "[ ] Plan".into(),
            },
            Event::error("TEST", "error"),
        ];
        for event in events {
            let frame = ServerFrame::new(42, event);
            assert_eq!(
                serde_json::from_slice::<ServerFrame>(&serde_json::to_vec(&frame)?)?,
                frame
            );
        }
        Ok(())
    }

    #[test]
    fn session_status_is_additive_and_roundtrips() -> Result<(), Box<dyn std::error::Error>> {
        let mut old_status = serde_json::to_value(Event::Status {
            session_id: None,
            status: "ready".into(),
            scratchpad: None,
            daemon: None,
        })?;
        old_status
            .as_object_mut()
            .ok_or("missing status object")?
            .remove("daemon");
        assert!(matches!(
            serde_json::from_value::<Event>(old_status)?,
            Event::Status { daemon: None, .. }
        ));
        let old: SessionInfo = serde_json::from_str(r#"{"id":"s","turn_count":0}"#)?;
        assert_eq!(old.status, None);
        for status in [
            SessionStatus::Running,
            SessionStatus::Idle,
            SessionStatus::Busy,
        ] {
            let current = SessionInfo {
                status: Some(status),
                ..old.clone()
            };
            assert_eq!(
                serde_json::from_slice::<SessionInfo>(&serde_json::to_vec(&current)?)?,
                current
            );
        }
        Ok(())
    }

    #[test]
    fn version_and_invalid_frame_errors() {
        for bytes in [
            br#"{"version":2,"id":7,"command":{"type":"ping"}}"#.as_slice(),
            br#"{"version":2,"id":7,"command":{"type":"future_command"}}"#.as_slice(),
        ] {
            assert!(
                matches!(decode_client(bytes).map_err(|frame| *frame), Err(ServerFrame { id: 7, event: Event::Error { code, .. }, .. }) if code == "IPC_VERSION_MISMATCH")
            );
        }
        assert!(
            matches!(decode_client(b"").map_err(|frame| *frame), Err(ServerFrame { event: Event::Error { code, .. }, .. }) if code == "IPC_INVALID_JSON")
        );
        assert!(
            matches!(decode_client(br#"{"version":1,"id":9}"#).map_err(|frame| *frame), Err(ServerFrame { id: 9, event: Event::Error { code, .. }, .. }) if code == "IPC_INVALID_FRAME")
        );
    }
}
