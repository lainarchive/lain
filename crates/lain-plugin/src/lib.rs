pub mod manifest;

mod manager;
mod runtime;

use async_trait::async_trait;
use manifest::{Capability, PluginManifest};
use serde_json::Value;

pub use manager::{PluginManager, MAX_SCRIPT_BYTES};

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
    async fn invoke(&self, tool: &str, arguments: Value) -> Result<Value, PluginError>;
}

pub use manager::DynamicPlugin;
