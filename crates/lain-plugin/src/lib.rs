pub mod manifest;

mod manager;
mod runtime;

use std::path::Path;

use async_trait::async_trait;
use manifest::{Capability, PluginManifest};
use serde_json::Value;

pub use manager::{ManifestEntry, PluginManager, MAX_SCRIPT_BYTES};

#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum PluginError {
    #[error("invalid plugin: {0}")]
    Invalid(String),
    #[error("{0} requires {1:?} permission")]
    Permission(String, Capability),
    #[error("plugin I/O: {0}")]
    Io(#[from] std::io::Error),
    #[error("plugin execution: {0}")]
    Execution(String),
    #[error("plugin timed out")]
    Timeout,
}

#[async_trait]
pub trait Plugin: Send + Sync {
    fn manifest(&self) -> &PluginManifest;
    /// Workspace-relative path, available after loading or successful persistence.
    fn manifest_path(&self) -> Option<&Path> {
        None
    }
    async fn invoke(&self, tool: &str, arguments: Value) -> Result<Value, PluginError>;
}

pub use manager::DynamicPlugin;
pub use runtime::ScriptExecution;
