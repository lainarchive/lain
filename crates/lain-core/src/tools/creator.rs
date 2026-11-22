use std::sync::{Arc, Weak};

use async_trait::async_trait;
use lain_plugin::{DynamicPlugin, MAX_SCRIPT_BYTES, PluginManager, manifest::ScriptProposal};
use serde_json::{Value, json};

use super::{
    RegisteredTool, Tool, ToolError, ToolOutput, ToolRegistry, UPDATE_SCRATCHPAD_TOOL_NAME,
    plugins::plugin_entries,
};

#[derive(Debug)]
pub struct CreateToolTool {
    manager: PluginManager,
    registry: Weak<ToolRegistry>,
}

impl CreateToolTool {
    pub fn new(manager: PluginManager, registry: &Arc<ToolRegistry>) -> Self {
        Self {
            manager,
            registry: Arc::downgrade(registry),
        }
    }
}

#[derive(Debug)]
pub struct TestToolTool {
    manager: PluginManager,
}

impl TestToolTool {
    pub fn new(manager: PluginManager) -> Self {
        Self { manager }
    }
}

impl ToolRegistry {
    pub fn register_creator_tools(
        self: &Arc<Self>,
        manager: PluginManager,
    ) -> Result<(), ToolError> {
        self.register_batch(
            vec![
                RegisteredTool::new(Arc::new(CreateToolTool::new(manager.clone(), self)))?,
                RegisteredTool::new(Arc::new(TestToolTool::new(manager)))?,
            ],
            || Ok(()),
        )
    }
}

fn script_schema() -> Value {
    json!({
        "type":"object",
        "properties":{
            "name":{"type":"string","pattern":"^[A-Za-z0-9_-]{1,64}$"},
            "description":{"type":"string","minLength":1},
            "parameters":{"type":"object","description":"JSON Schema for the generated tool's arguments"},
            "interpreter":{"type":"string","enum":["python","powershell","node"]},
            "source":{"type":"string","minLength":1,"maxLength":MAX_SCRIPT_BYTES,
                "description":"Read one stdin JSON-RPC 2.0 request to EOF. Write one JSON-RPC 2.0 response with the same id and a result or error to stdout. Use stderr for diagnostics."},
            "test_args":{"description":"Dummy arguments matching parameters, passed to the script as params"}
        },
        "required":["name","description","parameters","interpreter","source","test_args"],
        "additionalProperties":false
    })
}

fn prepare(
    manager: &PluginManager,
    request: ScriptProposal,
) -> Result<(Arc<DynamicPlugin>, RegisteredTool, Value), ToolError> {
    let plugin = Arc::new(manager.prepare_script(
        request.name,
        request.description,
        request.parameters,
        request.interpreter,
        request.source,
    )?);
    let entry = plugin_entries(plugin.clone())?
        .pop()
        .ok_or_else(|| ToolError::Execution("generated script has no tool export".into()))?;
    Ok((plugin, entry, request.test_args))
}

fn parse(args: Value) -> Result<ScriptProposal, ToolError> {
    serde_json::from_value(args).map_err(|e| ToolError::Arguments(e.to_string()))
}

pub async fn test_tool_proposal(
    manager: &PluginManager,
    proposal: ScriptProposal,
) -> Result<ToolOutput, ToolError> {
    let (_, entry, test_args) = prepare(manager, proposal)?;
    entry.dispatch(test_args).await
}

pub async fn publish_tool_proposal(
    manager: &PluginManager,
    registry: &ToolRegistry,
    proposal: ScriptProposal,
) -> Result<ToolOutput, ToolError> {
    if proposal.name == UPDATE_SCRATCHPAD_TOOL_NAME || registry.contains(&proposal.name) {
        return Err(ToolError::Duplicate(proposal.name));
    }
    let (plugin, entry, test_args) = prepare(manager, proposal)?;
    let test = entry.dispatch(test_args).await?;
    let name = entry.definition.name.clone();
    let path = registry.register_batch(vec![entry], || Ok(manager.persist_script(&plugin)?))?;
    Ok(ToolOutput {
        content: json!({"name":name,"path":path,"test_result":test.content}).to_string(),
        exit_code: Some(0),
    })
}

#[async_trait]
impl Tool for CreateToolTool {
    fn name(&self) -> &str {
        "create_tool"
    }

    fn description(&self) -> &str {
        "Test a new script with dummy arguments, then save it under .lain/tools and register it for this session only if the test passes"
    }

    fn parameters_schema(&self) -> Value {
        script_schema()
    }

    async fn execute(&self, args: Value) -> Result<ToolOutput, ToolError> {
        let registry = self
            .registry
            .upgrade()
            .ok_or_else(|| ToolError::Execution("tool registry closed".into()))?;
        publish_tool_proposal(&self.manager, &registry, parse(args)?).await
    }
}

#[async_trait]
impl Tool for TestToolTool {
    fn name(&self) -> &str {
        "test_tool"
    }

    fn description(&self) -> &str {
        "Run a trial of a proposed script tool with dummy arguments without saving or registering it"
    }

    fn parameters_schema(&self) -> Value {
        script_schema()
    }

    async fn execute(&self, args: Value) -> Result<ToolOutput, ToolError> {
        test_tool_proposal(&self.manager, parse(args)?).await
    }
}
