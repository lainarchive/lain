use std::time::Duration;

pub mod provider;
pub mod tools;

pub use lain_plugin as plugin;

#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum CoreError {
    #[error("HTTP transport: {0}")]
    Http(#[from] reqwest::Error),
    #[error("HTTP status {status}: {body}")]
    Status {
        status: u16,
        body: String,
        retry_after: Option<Duration>,
    },
    #[error("HTTP response stream ended before [DONE]")]
    IncompleteStream,
    #[error("Invalid JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Invalid completion: {0}")]
    Protocol(String),
}

impl CoreError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Http(_) | Self::IncompleteStream => "PROVIDER_HTTP_TRANSPORT",
            Self::Status { .. } => "PROVIDER_HTTP_STATUS",
            Self::Json(_) => "PROVIDER_JSON_INVALID",
            Self::Protocol(_) => "PROVIDER_PROTOCOL_INVALID",
        }
    }

    pub fn retry_delay(&self) -> Option<Duration> {
        match self {
            Self::Status {
                status: 408 | 429 | 500..=599,
                retry_after,
                ..
            } => Some(retry_after.unwrap_or_default()),
            Self::IncompleteStream => Some(Duration::ZERO),
            Self::Http(error)
                if error.is_timeout()
                    || error.is_connect()
                    || error.is_request()
                    || error.is_body()
                    || error.is_decode() =>
            {
                Some(Duration::ZERO)
            }
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_error_reason_codes() {
        let http = reqwest::Client::new()
            .get("://invalid")
            .build()
            .unwrap_err();
        let json = serde_json::from_str::<serde_json::Value>("").unwrap_err();
        for (error, code) in [
            (CoreError::Http(http), "PROVIDER_HTTP_TRANSPORT"),
            (
                CoreError::Status {
                    status: 401,
                    body: "denied".into(),
                    retry_after: None,
                },
                "PROVIDER_HTTP_STATUS",
            ),
            (CoreError::Json(json), "PROVIDER_JSON_INVALID"),
            (
                CoreError::Protocol("missing choice".into()),
                "PROVIDER_PROTOCOL_INVALID",
            ),
        ] {
            assert_eq!(error.code(), code);
        }
    }
}
