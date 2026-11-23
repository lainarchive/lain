use std::{collections::BTreeSet, sync::Arc};

use async_trait::async_trait;
use lain_plugin::{
    Plugin, PluginError, PluginManager,
    manifest::{Capability, ToolExport},
};
use serde_json::Value;

use super::{RegisteredTool, Tool, ToolError, ToolOutput, ToolRegistry, ToolSource};

struct PluginTool {
    plugin: Arc<dyn Plugin>,
    export: ToolExport,
}

#[async_trait]
impl Tool for PluginTool {
    fn name(&self) -> &str {
        &self.export.name
    }

    fn description(&self) -> &str {
        &self.export.description
    }

    fn parameters_schema(&self) -> Value {
        self.export.parameters.clone()
    }

    fn source(&self) -> ToolSource {
        ToolSource::Plugin {
            manifest_name: self.plugin.manifest().name.clone(),
            manifest_path: self
                .plugin
                .manifest_path()
                .map(std::path::Path::to_path_buf),
        }
    }

    fn manifest_permissions(&self) -> Option<BTreeSet<Capability>> {
        Some(self.plugin.manifest().permissions.clone())
    }

    async fn execute(&self, args: Value) -> Result<ToolOutput, ToolError> {
        let result = self.plugin.invoke(self.name(), args).await?;
        Ok(ToolOutput {
            content: result.to_string(),
            exit_code: Some(0),
        })
    }
}

pub(super) fn plugin_entries(plugin: Arc<dyn Plugin>) -> Result<Vec<RegisteredTool>, ToolError> {
    plugin
        .manifest()
        .tools
        .iter()
        .map(|export| {
            RegisteredTool::new(Arc::new(PluginTool {
                plugin: Arc::clone(&plugin),
                export: export.clone(),
            }))
        })
        .collect()
}

impl ToolRegistry {
    pub fn register_plugins(&self, manager: &PluginManager) -> Result<(), ToolError> {
        let mut entries = Vec::new();
        for plugin in manager.discover()? {
            entries.extend(plugin_entries(Arc::new(plugin))?);
        }
        self.register_batch(entries, || Ok(()))
    }
}

impl From<PluginError> for ToolError {
    fn from(error: PluginError) -> Self {
        match error {
            PluginError::Timeout => Self::Timeout(error.to_string()),
            PluginError::Permission(..) => Self::Permission(error.to_string()),
            PluginError::Invalid(message) => Self::Arguments(message),
            error => Self::Execution(error.to_string()),
        }
    }
}
