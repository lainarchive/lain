use serde::{Deserialize, Serialize};
use serde_json::Value;

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
    Ping,
    StartSession {
        session_id: Option<String>,
    },
    SendMessage {
        session_id: String,
        text: String,
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
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[non_exhaustive]
pub enum Event {
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
            Self::Pong { .. }
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
        let commands = vec![
            Command::Ping,
            Command::StartSession { session_id: None },
            Command::StartSession {
                session_id: Some("s".into()),
            },
            Command::SendMessage {
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
            },
            Event::Status {
                session_id: None,
                status: "idle".into(),
                scratchpad: None,
            },
            Event::Memory {
                episodic: vec!["episode".into()],
                procedural: vec!["rule".into()],
            },
            Event::Memory {
                episodic: vec![],
                procedural: vec![],
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
