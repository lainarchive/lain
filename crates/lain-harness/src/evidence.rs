use serde::{Deserialize, Serialize};

use crate::sensitive::SensitivePath;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Planned,
    PreparedNotObserved,
    ObservedVerified,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Evidence {
    TestRun {
        command: String,
        exit_code: i32,
        output_tail: Option<String>,
    },
    CompilerCheck {
        command: String,
        exit_code: i32,
        output_tail: Option<String>,
    },
}

impl Evidence {
    pub fn exit_code(&self) -> i32 {
        match self {
            Self::TestRun { exit_code, .. } | Self::CompilerCheck { exit_code, .. } => *exit_code,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum EvidenceError {
    #[error("transition is not allowed from {0:?}")]
    Transition(Status),
    #[error("verification requires nonempty evidence with all exit codes zero")]
    Unverified,
}

#[derive(Debug, Clone, Serialize)]
pub struct StepReport {
    step_id: String,
    status: Status,
    claim_boundary: String,
    evidence: Vec<Evidence>,
    /// Set when a path the step touches lands on a sensitive surface;
    /// marking never changes the outcome, it only tells the reviewer the
    /// claim needs a closer look.
    #[serde(skip_serializing_if = "Option::is_none")]
    sensitive: Option<SensitivePath>,
}

impl StepReport {
    pub fn new(step_id: impl Into<String>, claim_boundary: impl Into<String>) -> Self {
        Self {
            step_id: step_id.into(),
            status: Status::Planned,
            claim_boundary: claim_boundary.into(),
            evidence: vec![],
            sensitive: None,
        }
    }

    pub fn step_id(&self) -> &str {
        &self.step_id
    }
    pub fn status(&self) -> Status {
        self.status
    }
    pub fn claim_boundary(&self) -> &str {
        &self.claim_boundary
    }
    pub fn evidence(&self) -> &[Evidence] {
        &self.evidence
    }
    pub fn is_done(&self) -> bool {
        self.status == Status::ObservedVerified
    }
    pub fn mark_sensitive(&mut self, mark: SensitivePath) {
        self.sensitive = Some(mark);
    }
    pub fn sensitive(&self) -> Option<&SensitivePath> {
        self.sensitive.as_ref()
    }

    pub fn prepare(&mut self) -> Result<(), EvidenceError> {
        if self.status != Status::Planned {
            return Err(EvidenceError::Transition(self.status));
        }
        self.status = Status::PreparedNotObserved;
        Ok(())
    }

    pub fn verify(&mut self, evidence: Vec<Evidence>) -> Result<(), EvidenceError> {
        if self.status != Status::PreparedNotObserved {
            return Err(EvidenceError::Transition(self.status));
        }
        self.evidence = evidence;
        if self.evidence.is_empty() || self.evidence.iter().any(|item| item.exit_code() != 0) {
            return Err(EvidenceError::Unverified);
        }
        self.status = Status::ObservedVerified;
        Ok(())
    }

    pub(crate) fn exhausted(&mut self) {
        self.claim_boundary
            .push_str("; repair budget exhausted: no verified completion claimed");
    }
}
