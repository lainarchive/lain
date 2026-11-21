pub mod provider;
pub mod tools;

#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error("HTTP transport: {0}")]
    Http(#[from] reqwest::Error),
    #[error("HTTP status {status}: {body}")]
    Status { status: u16, body: String },
    #[error("Invalid JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Invalid completion: {0}")]
    Protocol(String),
}
