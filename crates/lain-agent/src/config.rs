use std::sync::Arc;

use lain_core::provider::{ModelProvider, OpenAiCompatibleProvider};
use serde::{Deserialize, Serialize};

use crate::AgentError;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[non_exhaustive]
pub enum ProviderSelection {
    /// The key is named, never stored: a config file can be committed without carrying a credential.
    OpenAiCompatible {
        base_url: String,
        api_key_env: Option<String>,
    },
}

impl ProviderSelection {
    pub fn build(&self) -> Result<Arc<dyn ModelProvider>, AgentError> {
        match self {
            Self::OpenAiCompatible {
                base_url,
                api_key_env,
            } => {
                let api_key = match api_key_env {
                    Some(name) => Some(std::env::var(name).map_err(|_| {
                        AgentError::Config(format!("environment variable {name} is not set"))
                    })?),
                    None => None,
                };
                Ok(Arc::new(OpenAiCompatibleProvider::new(
                    base_url.clone(),
                    api_key,
                )))
            }
        }
    }
}

/// `None` is unlimited for that dimension; `max_turns` still bounds every run.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct BudgetLimits {
    pub max_total_tokens: Option<u64>,
    pub max_completion_tokens: Option<u32>,
    pub max_tool_calls: Option<u32>,
    pub max_wall_time_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ToolCallMode {
    #[default]
    Native,
    /// Send tool schemas in the prompt for endpoints that do not accept OpenAI function schemas.
    HermesTags,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentConfig {
    pub provider: ProviderSelection,
    pub model: String,
    pub system_prompt: String,
    pub temperature: Option<f32>,
    /// Model calls allowed between one user input and the answer.
    pub max_turns: u32,
    pub max_consecutive_tool_errors: u32,
    /// Trusted memories recalled per input, and an upper bound on new-session heuristics; 0 turns recall off.
    pub memory_context_limit: i64,
    #[serde(default)]
    pub tool_call_mode: ToolCallMode,
    pub budget: BudgetLimits,
}

impl AgentConfig {
    pub fn new(provider: ProviderSelection, model: impl Into<String>) -> Self {
        Self {
            provider,
            model: model.into(),
            system_prompt: String::new(),
            temperature: None,
            max_turns: 16,
            max_consecutive_tool_errors: 3,
            memory_context_limit: 5,
            tool_call_mode: ToolCallMode::Native,
            budget: BudgetLimits::default(),
        }
    }

    pub fn validate(&self) -> Result<(), AgentError> {
        let fail = |message: &str| Err(AgentError::Config(message.into()));
        if self.model.trim().is_empty() {
            return fail("model is required");
        }
        if self.max_turns == 0 {
            return fail("max_turns must be at least 1");
        }
        if self.max_consecutive_tool_errors == 0 {
            return fail("max_consecutive_tool_errors must be at least 1");
        }
        if !(0..=100).contains(&self.memory_context_limit) {
            return fail("memory_context_limit must be 0..=100");
        }
        if let Some(t) = self.temperature {
            if !(0.0..=2.0).contains(&t) {
                return fail("temperature must be 0.0..=2.0");
            }
        }
        Ok(())
    }
}
