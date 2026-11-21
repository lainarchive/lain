use async_trait::async_trait;
use lain_core::{provider::*, tools::*};
use lain_memory::{MemoryInput, MemoryStore};
use serde_json::{Value, json};
#[cfg(target_os = "linux")]
use std::os::unix::fs::PermissionsExt;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

struct TestTool(Value);

#[test]
fn tool_error_reason_codes() {
    for (error, code) in [
        (ToolError::Duplicate("bash".into()), "TOOL_DUPLICATE"),
        (ToolError::Unknown("missing".into()), "TOOL_NOT_FOUND"),
        (
            ToolError::Schema("bad schema".into()),
            "TOOL_SCHEMA_INVALID",
        ),
        (
            ToolError::Arguments("bad args".into()),
            "TOOL_ARGUMENTS_INVALID",
        ),
        (
            ToolError::Execution("failed".into()),
            "TOOL_EXECUTION_FAILED",
        ),
        (ToolError::Timeout, "TOOL_TIMEOUT"),
    ] {
        assert_eq!(error.code(), code);
    }
}

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
    let killed = tool.execute(json!({"command":"kill -KILL $$"})).await;
    assert!(
        matches!(&killed, Err(ToolError::Execution(message)) if message.contains("without an exit code")),
        "{killed:?}"
    );
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
async fn bash_marks_truncation_after_lossy_utf8_expansion() {
    let directory = tempfile::tempdir().unwrap();
    let tool = BashTool {
        working_directory: directory.path().into(),
        timeout: Duration::from_secs(2),
        output_byte_cap: 4,
    };
    let output = tool
        .execute(json!({"command": r"printf '\xff\xff\xff\xff'"}))
        .await
        .unwrap();
    assert_eq!(output.exit_code, Some(0));
    let content: Value = serde_json::from_str(&output.content).unwrap();
    assert_eq!(content.get("stdout").unwrap(), "�\n[truncated]");
    assert_eq!(content.get("stderr").unwrap(), "");
}

#[tokio::test]
async fn powershell_schema_registration_and_missing_interpreter()
-> Result<(), Box<dyn std::error::Error>> {
    let directory = tempfile::tempdir()?;
    let tool = PowerShellTool::new(directory.path());
    assert_eq!(tool.timeout, PowerShellTool::DEFAULT_TIMEOUT);
    let mut registry = ToolRegistry::new();
    registry.register(Arc::new(tool.clone()))?;
    assert!(matches!(
        registry.register(Arc::new(tool)),
        Err(ToolError::Duplicate(_))
    ));
    let definitions = registry.definitions();
    let definition = definitions.first().ok_or("missing PowerShell definition")?;
    assert_eq!(definition.name, "powershell");
    let validator = jsonschema::validator_for(&definition.parameters)?;
    for args in [
        json!({"command":""}),
        json!({"command":"exit 0","timeout_ms":1000}),
        json!({"command":"exit 0","timeout_ms":u64::MAX}),
    ] {
        assert!(validator.is_valid(&args));
    }
    for args in [
        json!({}),
        json!({"command":1}),
        json!({"command":"","extra":1}),
        json!({"command":"","timeout_ms":0}),
        json!({"command":"","timeout_ms":-1}),
        json!({"command":"","timeout_ms":1.5}),
        json!({"command":"","timeout_ms":"100"}),
    ] {
        assert!(matches!(
            registry.dispatch("powershell", args).await,
            Err(ToolError::Arguments(_))
        ));
    }
    let missing =
        PowerShellTool::with_interpreter(directory.path(), directory.path().join("missing-pwsh"));
    assert!(
        matches!(missing.interpreter(), Err(ToolError::Execution(message)) if message.contains("PowerShell interpreter"))
    );
    assert!(matches!(
        missing.execute(json!({"command":"exit 0"})).await,
        Err(ToolError::Execution(_))
    ));
    assert!(matches!(
        missing.execute(json!({})).await,
        Err(ToolError::Arguments(_))
    ));
    assert!(matches!(
        missing.execute(json!({"command":"","timeout_ms":0})).await,
        Err(ToolError::Arguments(_))
    ));
    Ok(())
}

#[tokio::test]
async fn powershell_output_exit_code_and_override() -> Result<(), Box<dyn std::error::Error>> {
    let directory = tempfile::tempdir()?;
    let mut tool = PowerShellTool::new(directory.path());
    let Ok(interpreter) = tool.interpreter() else {
        return Ok(());
    };
    tool.output_byte_cap = 5;
    let output = tool.execute(json!({"command":"[Console]::Out.Write('éééé'); [Console]::Error.Write('error'); exit 7"})).await?;
    assert_eq!(output.exit_code, Some(7));
    assert_eq!(
        serde_json::from_str::<Value>(&output.content)?,
        json!({"stdout":"éé\n[truncated]","stderr":"error"})
    );
    let mut explicit = PowerShellTool::with_interpreter(directory.path(), interpreter);
    explicit.timeout = Duration::from_millis(1);
    let output = explicit
        .execute(json!({"command":"", "timeout_ms":10000}))
        .await?;
    assert_eq!(output.exit_code, Some(0));
    assert_eq!(
        serde_json::from_str::<Value>(&output.content)?,
        json!({"stdout":"","stderr":""})
    );
    explicit.timeout = Duration::MAX;
    let output = explicit.execute(json!({"command":"using namespace System.Text\nparam()\n[Console]::Out.Write([StringBuilder]::new('ok'))"})).await?;
    assert_eq!(
        serde_json::from_str::<Value>(&output.content)?,
        json!({"stdout":"ok","stderr":""})
    );
    let output = explicit
        .execute(
            json!({"command":"[Console]::Out.Write((Get-Location).Path)", "timeout_ms":u64::MAX}),
        )
        .await?;
    let content: Value = serde_json::from_str(&output.content)?;
    assert_eq!(
        std::path::PathBuf::from(
            content
                .get("stdout")
                .and_then(Value::as_str)
                .ok_or("missing stdout")?
        ),
        directory.path()
    );
    explicit.working_directory = directory.path().join("missing");
    assert!(matches!(
        explicit.execute(json!({"command":"exit 0"})).await,
        Err(ToolError::Execution(_))
    ));
    Ok(())
}

#[tokio::test]
async fn powershell_concurrent_capture_and_timeout() -> Result<(), Box<dyn std::error::Error>> {
    let directory = tempfile::tempdir()?;
    let mut tool = PowerShellTool::new(directory.path());
    if tool.interpreter().is_err() {
        return Ok(());
    }
    tool.output_byte_cap = 128;
    let output = tool.execute(json!({"command":"[Console]::Out.Write(('o' * 131072)); [Console]::Error.Write(('e' * 131072)); exit 3"})).await?;
    assert_eq!(output.exit_code, Some(3));
    let content: Value = serde_json::from_str(&output.content)?;
    assert_eq!(
        content.get("stdout"),
        Some(&json!(format!("{}\n[truncated]", "o".repeat(128))))
    );
    assert_eq!(
        content.get("stderr"),
        Some(&json!(format!("{}\n[truncated]", "e".repeat(128))))
    );
    tool.timeout = Duration::from_millis(100);
    assert!(matches!(
        tool.execute(json!({"command":"Start-Sleep -Seconds 10"}))
            .await,
        Err(ToolError::Timeout)
    ));
    tool.timeout = PowerShellTool::DEFAULT_TIMEOUT;
    assert!(matches!(
        tool.execute(json!({"command":"Start-Sleep -Seconds 10", "timeout_ms":100}))
            .await,
        Err(ToolError::Timeout)
    ));
    Ok(())
}

#[cfg(target_os = "linux")]
fn process_disappeared(error: &std::io::Error) -> bool {
    error.kind() == std::io::ErrorKind::NotFound || error.raw_os_error() == Some(3)
}

#[cfg(target_os = "linux")]
#[test]
fn vanished_process_errors() {
    for code in [2, 3] {
        assert!(process_disappeared(&std::io::Error::from_raw_os_error(
            code
        )));
    }
    assert!(!process_disappeared(&std::io::Error::from_raw_os_error(13)));
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn powershell_timeout_kills_descendants() -> Result<(), Box<dyn std::error::Error>> {
    let directory = tempfile::tempdir()?;
    let interpreter = directory.path().join("interpreter");
    std::fs::write(
        &interpreter,
        "#!/bin/sh\nsleep 30 &\necho $! > child.pid\nwait\n",
    )?;
    std::fs::set_permissions(&interpreter, std::fs::Permissions::from_mode(0o700))?;
    let mut tool = PowerShellTool::with_interpreter(directory.path(), interpreter);
    tool.timeout = Duration::from_millis(500);
    assert!(matches!(
        tool.execute(json!({"command":"ignored"})).await,
        Err(ToolError::Timeout)
    ));
    let pid = std::fs::read_to_string(directory.path().join("child.pid"))?
        .trim()
        .parse::<u32>()?;
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            match std::fs::read_to_string(format!("/proc/{pid}/status")) {
                Ok(status)
                    if status
                        .lines()
                        .any(|line| line.starts_with("State:") && line.contains("Z (zombie)")) =>
                {
                    break;
                }
                Ok(_) => tokio::time::sleep(Duration::from_millis(10)).await,
                Err(error) if process_disappeared(&error) => break,
                Err(error) => return Err(error),
            }
        }
        Ok::<(), std::io::Error>(())
    })
    .await??;
    Ok(())
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
    let float_limit_output = registry
        .dispatch("memory_read", json!({"query":"apple","limit":1.0}))
        .await
        .unwrap();
    assert_eq!(float_limit_output, output);
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
        json!({"query":"apple","limit":1.5}),
        json!({"query":"apple","limit":101.0}),
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
