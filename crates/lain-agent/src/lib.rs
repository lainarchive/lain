pub mod config;
pub mod control;
pub mod event;
mod hermes;
mod prompt;
mod reflection;
pub mod runner;
pub mod state;

pub use config::{AgentConfig, BudgetLimits, ProviderSelection, ToolCallMode};
pub use event::{AgentEvent, ToolOutcome};
pub use reflection::{ReflectionSummary, UserFeedback};
pub use runner::{AgentRunner, RunOutcome};
pub use state::{AgentState, AgentStatus, BudgetKind, Scratchpad, TerminationReason};

#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum AgentError {
    #[error("invalid agent config: {0}")]
    Config(String),
    #[error("input must not be blank")]
    EmptyInput,
    #[error("agent is terminated: {0:?}")]
    Terminated(TerminationReason),
    #[error("model provider: {0}")]
    Provider(#[from] lain_core::CoreError),
    #[error("memory store: {0}")]
    Memory(#[from] lain_memory::StoreError),
    #[error("memory worker: {0}")]
    Worker(String),
    #[error("session {0} already has a transcript in memory")]
    SessionExists(String),
    #[error("reflection requires this runner's completed or terminated session")]
    ReflectionUnavailable,
}

impl AgentError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Config(_) => "AGENT_CONFIG_INVALID",
            Self::EmptyInput => "AGENT_INPUT_EMPTY",
            Self::Terminated(_) => "AGENT_TERMINATED",
            Self::Provider(_) => "AGENT_PROVIDER_FAILED",
            Self::Memory(_) => "AGENT_MEMORY_FAILED",
            Self::Worker(_) => "AGENT_MEMORY_WORKER_FAILED",
            Self::SessionExists(_) => "AGENT_SESSION_EXISTS",
            Self::ReflectionUnavailable => "AGENT_REFLECTION_UNAVAILABLE",
        }
    }
}
