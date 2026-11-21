use async_trait::async_trait;
use lain_core::{provider::*, tools::*};
use lain_memory::{MemoryInput, MemoryStore};
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

struct TestTool(Value);
#[async_trait]
impl Tool for TestTool {
    fn name(&self) -> &str {
        "test"
    }
    fn description(&self) -> &str {
        "test"
    }
    fn parameters_schema(&self) -> Value {
        self.0.clone()
    }
    async fn execute(&self, _: Value) -> Result<ToolOutput, ToolError> {
        Ok(ToolOutput {
            content: "ok".into(),
            exit_code: None,
        })
    }
}

#[tokio::test]
async fn registry_validates_before_dispatch() {
    let mut registry = ToolRegistry::new();
    assert!(registry.definitions().is_empty());
    assert!(matches!(
        registry.dispatch("absent", json!({})).await,
        Err(ToolError::Unknown(_))
    ));
    assert!(matches!(
        registry.register(Arc::new(TestTool(json!({"type":"nonsense"})))),
        Err(ToolError::Schema(_))
    ));
    let tool = Arc::new(TestTool(
        json!({"type":"object","properties":{"count":{"type":"integer","minimum":1}},"required":["count"],"additionalProperties":false}),
    ));
    registry.register(tool.clone()).unwrap();
    assert!(matches!(
        registry.register(tool),
        Err(ToolError::Duplicate(_))
    ));
    assert_eq!(registry.definitions().len(), 1);
    assert_eq!(
        registry
            .dispatch("test", json!({"count":2}))
            .await
            .unwrap()
            .content,
        "ok"
    );
    for args in [
        json!({}),
        json!({"count":"2"}),
        json!({"count":0}),
        json!({"count":2,"other":1}),
    ] {
        assert!(matches!(
            registry.dispatch("test", args).await,
            Err(ToolError::Arguments(_))
        ));
    }
    let response = CompletionResponse {
        message: Message {
            role: Role::Assistant,
            content: None,
            tool_calls: vec![ToolCall {
                id: "c".into(),
                name: "missing".into(),
                arguments: json!({}),
            }],
            tool_call_id: None,
        },
        finish_reason: None,
        usage: None,
    };
    let messages = registry.tool_messages(&response).await;
    assert_eq!(messages.first().unwrap().tool_call_id.as_deref(), Some("c"));
    assert!(
        messages
            .first()
            .unwrap()
            .content
            .as_ref()
            .unwrap()
            .contains("unknown tool")
    );
    let empty = CompletionResponse {
        message: Message::text(Role::Assistant, "done"),
        finish_reason: None,
        usage: None,
    };
    assert!(registry.tool_messages(&empty).await.is_empty());
}

#[tokio::test]
async fn bash_output_limits_exit_environment_and_timeout() {
    let directory = tempfile::tempdir().unwrap();
    let mut tool = BashTool {
        working_directory: directory.path().into(),
        timeout: Duration::from_secs(2),
        output_byte_cap: 5,
    };
    let output = tool
        .execute(json!({"command":"printf 'éééé'; printf error >&2; exit 7"}))
        .await
        .unwrap();
    assert_eq!(output.exit_code, Some(7));
    let content: Value = serde_json::from_str(&output.content).unwrap();
    assert_eq!(content.get("stdout").unwrap(), "éé\n[truncated]");
    assert_eq!(content.get("stderr").unwrap(), "error");
    let output = tool.execute(json!({"command":"true"})).await.unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&output.content).unwrap(),
        json!({"stdout":"","stderr":""})
    );
    tool.output_byte_cap = 2048;
    let output = tool
        .execute(json!({"command":"printf '%s' \"${HOME-unset}\"; pwd; read ignored || true"}))
        .await
        .unwrap();
    assert!(output.content.contains("unset"));
    assert!(output.content.contains(directory.path().to_str().unwrap()));
    assert!(matches!(
        tool.execute(json!({})).await,
        Err(ToolError::Arguments(_))
    ));
    tool.timeout = Duration::from_millis(30);
    assert!(matches!(
        tool.execute(json!({"command":"exec sleep 10"})).await,
        Err(ToolError::Timeout)
    ));
    tool.working_directory = directory.path().join("missing");
    assert!(matches!(
        tool.execute(json!({"command":"true"})).await,
        Err(ToolError::Execution(_))
    ));
}

#[tokio::test]
async fn memory_search_respects_trust_and_errors() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = MemoryStore::open(directory.path().join("memory.db")).unwrap();
    store
        .remember(MemoryInput {
            id: None,
            title: "apples".into(),
            content: "apple context".into(),
            kind: None,
            trust: Some("trusted".into()),
            source: "test".into(),
        })
        .unwrap();
    store
        .remember(MemoryInput {
            id: None,
            title: "apples private".into(),
            content: "apple untrusted".into(),
            kind: None,
            trust: None,
            source: "test".into(),
        })
        .unwrap();
    let store = Arc::new(Mutex::new(store));
    let tool = Arc::new(MemoryReadTool::new(store.clone()));
    let mut registry = ToolRegistry::new();
    registry.register(tool).unwrap();
    let output = registry
        .dispatch("memory_read", json!({"query":"apple","limit":1}))
        .await
        .unwrap();
    let records: Vec<Value> = serde_json::from_str(&output.content).unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records.first().unwrap().get("trust").unwrap(), "trusted");
    assert_eq!(
        registry
            .dispatch("memory_read", json!({"query":"absent"}))
            .await
            .unwrap()
            .content,
        "[]"
    );
    for args in [
        json!({}),
        json!({"query":""}),
        json!({"query":"apple","limit":0}),
    ] {
        assert!(matches!(
            registry.dispatch("memory_read", args).await,
            Err(ToolError::Arguments(_))
        ));
    }
    store.lock().unwrap().close().unwrap();
    assert!(matches!(
        registry
            .dispatch("memory_read", json!({"query":"apple"}))
            .await,
        Err(ToolError::Execution(_))
    ));
}
