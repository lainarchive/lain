pub mod args;
mod cli;
pub use cli::run;
pub mod daemon;
pub mod dashboard;
pub mod doctor;
pub mod render;
pub mod run_report;
pub mod tui;
pub mod ui;
#[cfg(any(windows, test))]
mod windows_launcher;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{code}: {message}")]
    Failure { code: &'static str, message: String },
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Ipc(#[from] lain_ipc::Error),
    #[error(transparent)]
    Agent(#[from] lain_agent::AgentError),
    #[error(transparent)]
    Memory(#[from] lain_memory::StoreError),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Tool(#[from] lain_core::tools::ToolError),
}

impl Error {
    pub(crate) fn into_event(self) -> lain_ipc::Event {
        let code = self.code().into();
        let message = match self {
            Self::Failure { message, .. } => message,
            other => other.to_string(),
        };
        lain_ipc::Event::Error { code, message }
    }

    pub fn failure(code: &'static str, message: impl ToString) -> Self {
        Self::Failure {
            code,
            message: message.to_string(),
        }
    }

    pub fn code(&self) -> &'static str {
        match self {
            Self::Failure { code, .. } => code,
            Self::Agent(error) => error.code(),
            Self::Memory(error) => error.code(),
            Self::Tool(error) => error.code(),
            Self::Io(_) => "CLI_IO",
            Self::Ipc(_) => "CLI_IPC",
            Self::Json(_) => "CLI_JSON",
        }
    }
}
