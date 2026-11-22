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
    assert_eq!(direct.execution.exit_code, Some(0));
    assert!(direct.execution.error.is_none());
    assert!(!direct.execution.stdout.is_empty());
    assert_eq!(direct.execution.stderr, "");
    assert!(direct.execution.duration_ms > 0);
    assert_eq!(direct.execution.result, Some(json!({"value":"hello"})));
    assert!(direct.written_paths.is_empty());
    let agent = registry.dispatch("test_tool", args.clone()).await?;
    assert_eq!(agent.content, json!({"value":"hello"}).to_string());
    assert_eq!(agent.exit_code, Some(0));
    assert_eq!(
        serde_json::from_str::<Value>(&agent.content)?,
        json!({"value":"hello"})
    );
    assert!(!directory.path().join(".lain").exists());
    assert!(!registry.contains("echo_proposal"));
    let published = publish_tool_proposal(&manager, &registry, request.clone()).await?;
    assert_eq!(published.execution.result, Some(json!({"value":"hello"})));
    assert_eq!(published.written_paths.len(), 2);
    assert_eq!(
        published.written_paths,
        [
            std::path::PathBuf::from(".lain/tools/tool-echo_proposal.py"),
            std::path::PathBuf::from(".lain/tools/tool-echo_proposal.json"),
        ]
    );
    let mut agent_request = request.clone();
    agent_request.name = "agent_echo".into();
    let agent_publish = registry
        .dispatch("create_tool", serde_json::to_value(agent_request)?)
        .await?;
    assert_eq!(agent_publish.exit_code, Some(0));
    assert_eq!(
        agent_publish.content,
        json!({"name":"agent_echo", "path":".lain/tools/tool-agent_echo.py",
        "test_result":json!({"value":"hello"}).to_string()})
        .to_string()
    );
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
async fn execution_reports_keep_failed_trials_without_publishing()
-> Result<(), Box<dyn std::error::Error>> {
    let directory = tempfile::tempdir()?;
    let manager = PluginManager::new(
        directory.path(),
        HOST_PROCESS_PERMISSIONS.into_iter().collect(),
    );
    let registry = Arc::new(ToolRegistry::new());
    registry.register_creator_tools(manager.clone())?;
    for (source, code, message) in [
        (
            "import sys\nprint('partial')\nprint('diagnostic', file=sys.stderr)\nsys.exit(7)",
            7,
            "process exited with",
        ),
        (
            "import sys\nprint('not json')\nprint('diagnostic', file=sys.stderr)",
            0,
            "invalid JSON-RPC response",
        ),
        (
            "import sys\nprint('diagnostic', file=sys.stderr)",
            0,
            "invalid JSON-RPC response",
        ),
    ] {
        let mut request = proposal()?;
        request.source = source.into();
        let report = test_tool_proposal(&manager, request.clone()).await?;
        assert_eq!(report.execution.exit_code, Some(code));
        assert!(report.execution.stderr.contains("diagnostic"));
        assert!(
            report
                .execution
                .error
                .as_deref()
                .is_some_and(|e| e.contains(message))
        );
        assert!(report.execution.result.is_none());
        let decoded: lain_core::tools::CreatorReport =
            serde_json::from_str(&serde_json::to_string(&report)?)?;
        assert_eq!(decoded, report);
        if source.contains("partial") {
            assert!(report.execution.stdout.contains("partial"));
        }
        let failed_publish = publish_tool_proposal(&manager, &registry, request.clone()).await?;
        assert!(failed_publish.execution.error.is_some());
        assert!(failed_publish.written_paths.is_empty());
        for tool in ["test_tool", "create_tool"] {
            let error = registry
                .dispatch(tool, serde_json::to_value(&request)?)
                .await
                .unwrap_err();
            assert_eq!(error.code(), "TOOL_EXECUTION_FAILED");
            assert!(error.to_string().contains(message));
            assert!(error.to_string().contains("diagnostic"));
        }
        assert!(!registry.contains("echo_proposal"));
        assert!(!directory.path().join(".lain").exists());
    }
    Ok(())
}

#[tokio::test]
async fn execution_reports_retain_decoded_results_and_diagnostics()
-> Result<(), Box<dyn std::error::Error>> {
    let directory = tempfile::tempdir()?;
    let manager = PluginManager::new(
        directory.path(),
        HOST_PROCESS_PERMISSIONS.into_iter().collect(),
    );
    let registry = Arc::new(ToolRegistry::new());
    registry.register_creator_tools(manager.clone())?;
    for code in [0, 7] {
        let mut request = proposal()?;
        request.source.push_str(&format!(
            "print('trace', file=sys.stderr)\nsys.exit({code})\n"
        ));
        let started = std::time::Instant::now();
        let report = test_tool_proposal(&manager, request.clone()).await?;
        assert_eq!(report.execution.exit_code, Some(code));
        assert_eq!(report.execution.result, Some(json!({"value":"hello"})));
        assert_eq!(report.execution.stderr, "trace\n");
        assert!(u128::from(report.execution.duration_ms) <= started.elapsed().as_millis());
        let decoded: lain_core::tools::CreatorReport =
            serde_json::from_str(&serde_json::to_string(&report)?)?;
        assert_eq!(decoded, report);
        let agent = registry
            .dispatch("test_tool", serde_json::to_value(request)?)
            .await;
        if let Some(error) = report.execution.error {
            assert_eq!(
                agent.unwrap_err().to_string(),
                format!("tool execution: plugin execution: {error}")
            );
        } else {
            assert_eq!(agent?.content, json!({"value":"hello"}).to_string());
        }
    }
    Ok(())
}

#[tokio::test]
async fn execution_reports_preserve_null_results() -> Result<(), Box<dyn std::error::Error>> {
    let directory = tempfile::tempdir()?;
    let manager = PluginManager::new(
        directory.path(),
        HOST_PROCESS_PERMISSIONS.into_iter().collect(),
    );
    let registry = Arc::new(ToolRegistry::new());
    registry.register_creator_tools(manager.clone())?;
    let mut request = proposal()?;
    request.source = "import json,sys\nr=json.load(sys.stdin)\nprint(json.dumps({'jsonrpc':'2.0','id':r['id'],'result':None}))\n".into();
    let report = test_tool_proposal(&manager, request.clone()).await?;
    assert_eq!(report.execution.result, Some(Value::Null));
    let decoded: lain_core::tools::CreatorReport =
        serde_json::from_str(&serde_json::to_string(&report)?)?;
    assert_eq!(decoded, report);
    assert_eq!(
        registry
            .dispatch("test_tool", serde_json::to_value(request)?)
            .await?
            .content,
        "null"
    );
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
