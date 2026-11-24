use lain_core::tools::ToolOutput;
use serde::Serialize;
use serde_json::Value;

use crate::state::TerminationReason;

#[derive(Debug, Clone, Serialize, PartialEq, ts_rs::TS)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum ToolOutcome {
    Succeeded(ToolOutput),
    Failed {
        code: String,
        message: String,
    },
    Skipped {
        reason: String,
    },
    /// Started but cut off by cancellation or the wall-time budget; any side effects it had may have happened.
    Interrupted {
        reason: String,
    },
}

impl ToolOutcome {
    /// A nonzero exit counts against the circuit breaker: a model retrying the same failing command is the runaway it exists for.
    pub fn is_error(&self) -> bool {
        match self {
            Self::Succeeded(output) => output.exit_code.is_some_and(|code| code != 0),
            Self::Failed { .. } => true,
            Self::Skipped { .. } | Self::Interrupted { .. } => false,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, ts_rs::TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[non_exhaustive]
pub enum AgentEvent {
    ThinkingToken {
        turn: u32,
        text: String,
    },
    IntentReceived {
        text: String,
    },
    ApprovalRequired {
        turn: u32,
        call_id: String,
        name: String,
        arguments: Value,
    },
    ScratchpadUpdated {
        plan: String,
    },
    ReflectionGenerated {
        summary: String,
        rules: Vec<String>,
    },
    ErrorTripped {
        code: String,
        message: String,
    },
    SessionCompleted {
        reason: String,
    },
    ContextMeasured {
        prompt_tokens: usize,
        memory_tokens: usize,
        repo_map_tokens: usize,
        tool_tokens: usize,
    },
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
        #[ts(type = "number")]
        tokens_used: u64,
    },
    Terminated {
        turn: u32,
        reason: TerminationReason,
    },
    ReflectionFailed {
        code: String,
    },
    /// The task's exact requirements, extracted before the first turn ran.
    RequirementsExtracted {
        items: Vec<String>,
    },
    /// The pre-finish check's verdict on the proposed output.
    RequirementsChecked {
        satisfied: bool,
        missing: Vec<String>,
    },
}
