use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};

use async_trait::async_trait;
use lain_context::RepoMapCache;
use serde_json::{Value, json};

use super::{Tool, ToolError, ToolOutput};

pub const REPO_MAP_TOOL_NAME: &str = "repo_map";

/// The caller selects the trusted workspace root; the model cannot supply a path.
#[derive(Debug, Clone)]
pub struct RepoMapTool {
    root: PathBuf,
    cache: Arc<Mutex<RepoMapCache>>,
}

impl RepoMapTool {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            cache: Arc::new(Mutex::new(RepoMapCache::default())),
        }
    }
}

#[async_trait]
impl Tool for RepoMapTool {
    fn name(&self) -> &str {
        REPO_MAP_TOOL_NAME
    }

    fn description(&self) -> &str {
        "Outline Rust and TypeScript symbols, signatures, and doc summaries in the authorized workspace."
    }

    fn parameters_schema(&self) -> Value {
        json!({"type": "object", "properties": {}, "additionalProperties": false})
    }

    async fn execute(&self, args: Value) -> Result<ToolOutput, ToolError> {
        if !args.as_object().is_some_and(serde_json::Map::is_empty) {
            return Err(ToolError::Arguments("repo_map accepts no arguments".into()));
        }
        let root = self.root.clone();
        let cache = self.cache.clone();
        let map = tokio::task::spawn_blocking(move || {
            cache
                .lock()
                .map_err(|error| ToolError::Execution(error.to_string()))?
                .scan(root)
                .map_err(|error| ToolError::Execution(error.to_string()))
        })
        .await
        .map_err(|error| ToolError::Execution(error.to_string()))??;
        let mut content = map.as_str().to_owned();
        if map.is_truncated() {
            content.push_str("[repo map incomplete: read, parse, or scan limit]\n");
        }
        Ok(ToolOutput {
            content,
            exit_code: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::ToolRegistry;

    #[tokio::test]
    async fn dispatches_only_against_the_registered_workspace()
    -> Result<(), Box<dyn std::error::Error>> {
        let root = tempfile::tempdir()?;
        std::fs::write(
            root.path().join("index.ts"),
            "export function start() { throw new Error('body'); }",
        )?;
        let mut tools = ToolRegistry::new();
        let tool = RepoMapTool::new(root.path());
        tools.register(Arc::new(tool.clone()))?;
        assert!(matches!(
            tools
                .dispatch(REPO_MAP_TOOL_NAME, json!({"path": ".."}))
                .await,
            Err(ToolError::Arguments(_))
        ));
        let result = tools.dispatch(REPO_MAP_TOOL_NAME, json!({})).await?;
        assert_eq!(result.content, "index.ts:\n  export function start()\n");
        assert_eq!(
            tools.dispatch(REPO_MAP_TOOL_NAME, json!({})).await?.content,
            result.content
        );
        assert_eq!(
            tool.cache.lock().map_err(|e| e.to_string())?.parse_count(),
            1
        );
        Ok(())
    }
}
