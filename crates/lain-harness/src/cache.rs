use lain_core::provider::{Message, Role};

#[derive(Debug, thiserror::Error)]
pub enum TranscriptError {
    #[error("tool call is unknown, already completed or no longer live: {0}")]
    Tool(String),
    #[error("pending tool call must complete before commit")]
    Pending,
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

#[derive(Debug, Default)]
pub struct FrozenTranscript {
    committed: Vec<Message>,
    prefix: Vec<u8>,
    live: Vec<Message>,
}

impl FrozenTranscript {
    pub fn push(&mut self, message: Message) {
        self.live.push(message);
    }
    pub fn prefix_bytes(&self) -> &[u8] {
        &self.prefix
    }
    pub fn messages(&self) -> Vec<Message> {
        self.committed.iter().chain(&self.live).cloned().collect()
    }

    pub fn complete_tool(
        &mut self,
        call_id: &str,
        content: impl Into<String>,
    ) -> Result<(), TranscriptError> {
        let pending = self
            .live
            .iter()
            .any(|m| m.role == Role::Assistant && m.tool_calls.iter().any(|c| c.id == call_id));
        let completed = self
            .live
            .iter()
            .any(|m| m.role == Role::Tool && m.tool_call_id.as_deref() == Some(call_id));
        if !pending || completed {
            return Err(TranscriptError::Tool(call_id.into()));
        }
        let mut message = Message::text(Role::Tool, content);
        message.tool_call_id = Some(call_id.into());
        self.live.push(message);
        Ok(())
    }

    pub fn commit(&mut self) -> Result<(), TranscriptError> {
        let pending =
            self.live
                .iter()
                .filter(|m| m.role == Role::Assistant)
                .flat_map(|m| &m.tool_calls)
                .any(|call| {
                    !self.live.iter().any(|m| {
                        m.role == Role::Tool && m.tool_call_id.as_deref() == Some(&call.id)
                    })
                });
        if pending {
            return Err(TranscriptError::Pending);
        }
        let encoded: Result<Vec<Vec<u8>>, _> = self.live.iter().map(serde_json::to_vec).collect();
        for bytes in encoded? {
            self.prefix.extend(bytes);
            self.prefix.push(b'\n');
        }
        self.committed.append(&mut self.live);
        Ok(())
    }
}
