use lain_core::provider::Message;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BudgetKind {
    TotalTokens,
    ToolCalls,
    WallTime,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "reason", rename_all = "snake_case")]
#[non_exhaustive]
pub enum TerminationReason {
    MaxTurns,
    ToolErrorLimit,
    BudgetExhausted {
        budget: BudgetKind,
    },
    ProviderFailed,
    MemoryFailed,
    Cancelled,
    /// A token cap is set but the provider reported no usage, so the cap could not be enforced.
    UsageUnreported,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum AgentStatus {
    Idle,
    Running,
    AwaitingInput,
    Terminated(TerminationReason),
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Scratchpad {
    pub plan: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentState {
    pub session_id: String,
    pub messages: Vec<Message>,
    pub turn_count: u32,
    pub status: AgentStatus,
    pub inputs: u32,
    pub tool_calls: u32,
    pub tokens_used: u64,
    pub consecutive_tool_errors: u32,
    #[serde(default)]
    pub tool_errors: u32,
    #[serde(default)]
    pub scratchpad: Scratchpad,
}

impl AgentState {
    pub fn new(session_id: impl Into<String>) -> Self {
        Self {
            session_id: session_id.into(),
            messages: Vec::new(),
            turn_count: 0,
            status: AgentStatus::Idle,
            inputs: 0,
            tool_calls: 0,
            tokens_used: 0,
            consecutive_tool_errors: 0,
            tool_errors: 0,
            scratchpad: Scratchpad::default(),
        }
    }
}
