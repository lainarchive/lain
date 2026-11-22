use std::sync::{Arc, Mutex, PoisonError};

use serde::Serialize;
use tokio::sync::Notify;

#[derive(Debug, Clone, Default, Serialize, ts_rs::TS)]
pub struct ControlState {
    pub paused: bool,
    pub intercept: bool,
    pub pending_call: Option<String>,
    #[serde(skip)]
    decision: Option<bool>,
    #[serde(skip)]
    steering: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn pause_holds_approval_until_resume_and_decisions_are_single_use() {
        let control = AgentControl::default();
        assert!(!control.require_approval("unguarded"));
        assert!(control.ready().await);
        assert!(!control.decide("missing", true));
        control.intercept(true);
        assert!(control.require_approval("call"));
        assert!(!control.decide("stale", true));
        control.pause(true);
        assert!(control.decide("call", true));
        assert!(!control.decide("call", false));
        let waiting = control.ready();
        tokio::pin!(waiting);
        assert!(futures::poll!(&mut waiting).is_pending());
        control.pause(false);
        assert!(waiting.await);
        assert!(control.snapshot().pending_call.is_none());
        assert!(!control.decide("call", true));
        assert!(control.require_approval("next"));
        assert!(control.decide("next", false));
        assert!(!control.ready().await);
        assert!(control.require_approval("abandoned"));
        control.clear_pending();
        assert!(control.ready().await);
    }

    #[test]
    fn steering_is_bounded_ordered_and_drained_once() {
        let control = AgentControl::default();
        assert!(control.take_steering().is_empty());
        assert!(!control.steer(" \n".into()));
        assert!(!control.steer("x".repeat(8001)));
        for index in 0..8 {
            assert!(control.steer(index.to_string()));
        }
        assert!(!control.steer("overflow".into()));
        assert_eq!(
            control.take_steering(),
            ["0", "1", "2", "3", "4", "5", "6", "7"]
        );
        assert!(control.take_steering().is_empty());
        assert!(control.steer("x".repeat(8000)));
    }
}

#[derive(Debug, Clone, Default)]
pub struct AgentControl {
    state: Arc<Mutex<ControlState>>,
    changed: Arc<Notify>,
}

impl AgentControl {
    pub fn snapshot(&self) -> ControlState {
        self.state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    pub fn pause(&self, paused: bool) {
        self.state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .paused = paused;
        self.changed.notify_one();
    }

    pub fn intercept(&self, enabled: bool) {
        self.state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .intercept = enabled;
        self.changed.notify_one();
    }

    pub fn decide(&self, call_id: &str, approve: bool) -> bool {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if state.pending_call.as_deref() != Some(call_id) || state.decision.is_some() {
            return false;
        }
        state.decision = Some(approve);
        self.changed.notify_one();
        true
    }

    pub fn steer(&self, text: String) -> bool {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if text.trim().is_empty() || text.len() > 8000 || state.steering.len() >= 8 {
            return false;
        }
        state.steering.push(text);
        true
    }

    pub(crate) fn take_steering(&self) -> Vec<String> {
        std::mem::take(
            &mut self
                .state
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .steering,
        )
    }

    pub(crate) fn require_approval(&self, call_id: &str) -> bool {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if !state.intercept {
            return false;
        }
        state.pending_call = Some(call_id.into());
        state.decision = None;
        true
    }

    pub(crate) fn clear_pending(&self) {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.pending_call = None;
        state.decision = None;
    }

    pub(crate) async fn ready(&self) -> bool {
        loop {
            let notified = self.changed.notified();
            {
                let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
                if !state.paused {
                    if state.pending_call.is_none() {
                        return true;
                    }
                    if let Some(approved) = state.decision.take() {
                        state.pending_call = None;
                        return approved;
                    }
                }
            }
            notified.await;
        }
    }
}
