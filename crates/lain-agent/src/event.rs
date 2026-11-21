use lain_core::tools::ToolOutput;
use serde::Serialize;
use serde_json::Value;

use crate::state::TerminationReason;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum ToolOutcome {
    Succeeded(ToolOutput),
    Failed { code: String, message: String },
    Skipped { reason: String },
}

impl ToolOutcome {
    /// A nonzero exit counts against the circuit breaker: a model retrying the same failing command is the runaway it exists for.
    pub fn is_error(&self) -> bool {
        match self {
            Self::Succeeded(output) => output.exit_code.is_some_and(|code| code != 0),
            Self::Failed { .. } => true,
            Self::Skipped { .. } => false,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
#[non_exhaustive]
pub enum AgentEvent {
    TurnStarted {
        session_id: String,
        turn: u32,
    },
    /// Text the model sent alongside its tool calls.
    Thinking {
        turn: u32,
        text: String,
    },
    ToolInvoked {
        turn: u32,
        call_id: String,
        name: String,
        arguments: Value,
    },
    ToolCompleted {
        turn: u32,
        call_id: String,
        name: String,
        outcome: ToolOutcome,
    },
    OutputGenerated {
        turn: u32,
        text: String,
    },
    TurnCompleted {
        turn: u32,
        tool_calls: usize,
        tokens_used: u64,
    },
    Terminated {
        turn: u32,
        reason: TerminationReason,
    },
}
