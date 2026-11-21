use lain_memory::{MemoryStore, StoreError};
use serde::{Deserialize, Serialize};

use crate::{AgentState, AgentStatus, TerminationReason};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UserFeedback {
    Confirmed,
    NeedsCorrection,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ReflectionSummary {
    pub session_id: String,
    pub inputs: u32,
    pub turns: u32,
    pub tool_calls: u32,
    pub tool_errors: u32,
    pub feedback: Option<UserFeedback>,
    pub rules: Vec<String>,
}

impl ReflectionSummary {
    // A local pass costs no inference or tools, even after cancellation or budget exhaustion.
    pub(crate) fn synthesize(state: &AgentState, feedback: Option<UserFeedback>) -> Self {
        let mut rules = Vec::new();
        if feedback == Some(UserFeedback::NeedsCorrection) {
            rules.push(
                "Restate the corrected requirement and verify it before reporting completion.",
            );
        }
        if state.tool_errors > 0 {
            rules.push("Read a failed tool's error and change the next action before retrying.");
        }
        if state.turn_count > state.inputs.saturating_mul(3)
            || state.status == AgentStatus::Terminated(TerminationReason::MaxTurns)
        {
            rules.push("Plan related checks together and stop taking tool turns once the result is verified.");
        }
        if feedback == Some(UserFeedback::Confirmed) {
            rules
                .push("Reuse the verification step the user confirmed before broadening the task.");
        }
        if rules.is_empty() {
            rules.push(match &state.status {
                AgentStatus::Terminated(_) => {
                    "Identify the blocker early and report what remains unverified."
                }
                _ => "Answer directly once the requested result is verified.",
            });
        }
        Self {
            session_id: state.session_id.clone(),
            inputs: state.inputs,
            turns: state.turn_count,
            tool_calls: state.tool_calls,
            tool_errors: state.tool_errors,
            feedback,
            rules: rules.into_iter().map(str::to_owned).collect(),
        }
    }

    pub(crate) fn persist(self, store: &mut MemoryStore) -> Result<Self, StoreError> {
        let input = |number| {
            store
                .get(&format!("{}/input/{number}", self.session_id))?
                .map(|record| record.content)
                .ok_or(StoreError::NotFound)
        };
        // Clip after the transcript passed memory's redaction, not before.
        let clip = crate::runner::clip_utf16;
        let topic = if self.inputs == 1 {
            clip(&input(1)?, 1000)
        } else {
            format!(
                "{} {}",
                clip(&input(1)?, 499),
                clip(&input(self.inputs)?, 500)
            )
        };
        store.replace_procedural_rules(&self.session_id, &topic, &self.rules)?;
        Ok(self)
    }
}
