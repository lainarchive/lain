pub mod provider;
pub mod tools;

#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
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

impl CoreError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Http(_) => "PROVIDER_HTTP_TRANSPORT",
            Self::Status { .. } => "PROVIDER_HTTP_STATUS",
            Self::Json(_) => "PROVIDER_JSON_INVALID",
            Self::Protocol(_) => "PROVIDER_PROTOCOL_INVALID",
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
