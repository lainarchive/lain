use std::{
    future::Future,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};

use serde::{Deserialize, Serialize};
use tokio::{sync::mpsc, task::JoinHandle};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AdvisorKind {
    Aside,
    Warning,
    Blocker,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AdvisorNote {
    pub kind: AdvisorKind,
    pub turn: u64,
    pub text: String,
}

#[derive(Debug, thiserror::Error)]
#[error("advisor channel capacity must be between 1 and Semaphore::MAX_PERMITS")]
pub struct CapacityError;

#[derive(Debug, Clone)]
pub struct Advisor {
    sender: mpsc::Sender<AdvisorNote>,
    dropped: Arc<AtomicU64>,
}

impl Advisor {
    pub fn channel(capacity: usize) -> Result<(Self, mpsc::Receiver<AdvisorNote>), CapacityError> {
        if capacity == 0 || capacity > tokio::sync::Semaphore::MAX_PERMITS {
            return Err(CapacityError);
        }
        let (sender, receiver) = mpsc::channel(capacity);
        Ok((
            Self {
                sender,
                dropped: Arc::new(AtomicU64::new(0)),
            },
            receiver,
        ))
    }

    pub fn observe(&self, note: AdvisorNote) {
        if self.sender.try_send(note).is_err() {
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }

    pub fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }
}

pub trait AdvisorModel: Send + Sync + 'static {
    fn review(&self, turn_text: &str) -> impl Future<Output = Vec<AdvisorNote>> + Send;
}

pub fn spawn_advisor<M: AdvisorModel>(
    model: Arc<M>,
    advisor: Advisor,
    turn: u64,
    turn_text: String,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        for mut note in model.review(&turn_text).await {
            note.turn = turn;
            advisor.observe(note);
        }
    })
}
