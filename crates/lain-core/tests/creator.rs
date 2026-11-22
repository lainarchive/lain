use std::sync::Arc;

use lain_core::tools::{ToolError, ToolRegistry, publish_tool_proposal, test_tool_proposal};
use lain_plugin::{
    PluginManager,
    manifest::{HOST_PROCESS_PERMISSIONS, ScriptProposal},
};
use serde_json::{Value, json};

fn proposal() -> Result<ScriptProposal, serde_json::Error> {
    serde_json::from_value(json!({
        "name":"echo_proposal", "description":"Return the input", "parameters":{
            "type":"object", "properties":{"value":{"type":"string"}}, "required":["value"], "additionalProperties":false
        }, "interpreter":"python", "source":
            "import json,sys\nr=json.load(sys.stdin)\nprint(json.dumps({'jsonrpc':'2.0','id':r['id'],'result':r['params']}))\n",
        "test_args":{"value":"hello"}
    }))
}

#[tokio::test]
async fn shared_creator_paths_match_agent_tools() -> Result<(), Box<dyn std::error::Error>> {
    let directory = tempfile::tempdir()?;
    let manager = PluginManager::new(
        directory.path(),
        HOST_PROCESS_PERMISSIONS.into_iter().collect(),
    );
    let registry = Arc::new(ToolRegistry::new());
    registry.register_creator_tools(manager.clone())?;
    let request = proposal()?;
    let args = serde_json::to_value(&request)?;
    let direct = test_tool_proposal(&manager, request.clone()).await?;
    assert_eq!(direct, registry.dispatch("test_tool", args.clone()).await?);
    assert_eq!(
        serde_json::from_str::<Value>(&direct.content)?,
        json!({"value":"hello"})
    );
    assert!(!directory.path().join(".lain").exists());
    assert!(!registry.contains("echo_proposal"));
    let published = publish_tool_proposal(&manager, &registry, request.clone()).await?;
    let result: Value = serde_json::from_str(&published.content)?;
    assert_eq!(result["name"], "echo_proposal");
    assert_eq!(result["path"], ".lain/tools/tool-echo_proposal.py");
    assert!(
        directory
            .path()
            .join(".lain/tools/tool-echo_proposal.py")
            .is_file()
    );
    assert!(
        directory
            .path()
            .join(".lain/tools/tool-echo_proposal.json")
            .is_file()
    );
    assert!(registry.contains("echo_proposal"));
    assert_eq!(
        registry
            .dispatch("echo_proposal", json!({"value":"registered"}))
            .await?
            .content,
        json!({"value":"registered"}).to_string()
    );
    let duplicate = publish_tool_proposal(&manager, &registry, request).await;
    assert!(matches!(duplicate, Err(ToolError::Duplicate(_))));
    assert!(matches!(
        registry.dispatch("create_tool", args).await,
        Err(ToolError::Duplicate(_))
    ));
    Ok(())
}

#[tokio::test]
async fn shared_creator_paths_validate_before_writing() -> Result<(), Box<dyn std::error::Error>> {
    let directory = tempfile::tempdir()?;
    let manager = PluginManager::new(
        directory.path(),
        HOST_PROCESS_PERMISSIONS.into_iter().collect(),
    );
    let registry = Arc::new(ToolRegistry::new());
    registry.register_creator_tools(manager.clone())?;
    let mut invalid = proposal()?;
    invalid.source.clear();
    assert!(test_tool_proposal(&manager, invalid.clone()).await.is_err());
    assert!(
        publish_tool_proposal(&manager, &registry, invalid)
            .await
            .is_err()
    );
    let mut invalid = proposal()?;
    invalid.test_args = json!({});
    assert!(matches!(
        test_tool_proposal(&manager, invalid.clone()).await,
        Err(ToolError::Arguments(_))
    ));
    assert!(matches!(
        publish_tool_proposal(&manager, &registry, invalid).await,
        Err(ToolError::Arguments(_))
    ));
    let denied = PluginManager::new(directory.path(), Default::default());
    assert!(matches!(
        test_tool_proposal(&denied, proposal()?).await,
        Err(ToolError::Permission(_))
    ));
    assert!(matches!(
        publish_tool_proposal(&denied, &registry, proposal()?).await,
        Err(ToolError::Permission(_))
    ));
    assert!(!directory.path().join(".lain").exists());
    assert!(!registry.contains("echo_proposal"));
    Ok(())
}
