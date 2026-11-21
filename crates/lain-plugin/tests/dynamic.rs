use std::{
    collections::BTreeSet,
    fs,
    process::{Command, Stdio},
};

use lain_plugin::{
    manifest::{Capability, ScriptInterpreter, HOST_PROCESS_PERMISSIONS},
    Plugin, PluginManager,
};
use serde_json::json;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

#[tokio::test]
async fn powershell_script_preserves_utf8_json_rpc() -> Result<(), Box<dyn std::error::Error>> {
    let names: &[&str] = if cfg!(windows) {
        &["pwsh.exe", "powershell.exe"]
    } else {
        &["pwsh"]
    };
    if !names.iter().any(|name| {
        Command::new(name)
            .args(["-NoProfile", "-NonInteractive", "-Command", "exit 0"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }) {
        return Ok(());
    }
    let workspace = tempfile::tempdir()?;
    let manager = PluginManager::new(
        workspace.path(),
        HOST_PROCESS_PERMISSIONS.into_iter().collect(),
    );
    let plugin = manager.prepare_script(
        "echo_unicode".into(),
        "Echo non-ASCII arguments".into(),
        json!({"type":"object"}),
        ScriptInterpreter::Powershell,
        r#"
$request = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
@{jsonrpc='2.0'; id=$request.id; result=@{text=$request.params.text; literal='café'}} | ConvertTo-Json -Compress
"#.into(),
    )?;
    assert_eq!(
        plugin
            .invoke("echo_unicode", json!({"text":"東京"}))
            .await?,
        json!({"text":"東京","literal":"café"})
    );
    Ok(())
}

#[tokio::test]
async fn discovers_and_invokes_one_json_rpc_request() -> Result<(), Box<dyn std::error::Error>> {
    if !["python3", "python"].iter().any(|name| {
        Command::new(name)
            .arg("-I")
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    }) {
        return Ok(());
    }

    let workspace = tempfile::tempdir()?;
    let dir = workspace.path().join(".lain/plugins");
    fs::create_dir_all(&dir)?;
    fs::write(
        dir.join("echo.py"),
        r#"
import json, sys
request = json.load(sys.stdin)
assert request["jsonrpc"] == "2.0"
assert request["method"] == "echo_plugin"
if request["params"].get("fail"):
    print("script diagnostics", file=sys.stderr)
    sys.exit(3)
print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": request["params"]}))
"#,
    )?;
    let mut manifest = json!({
        "name":"echo",
        "version":"0.1.0",
        "author":"test fixture",
        "permissions":["read_fs","write_fs","network","subprocess"],
        "tools":[{"name":"echo_plugin","description":"Echo RPC params","parameters":{"type":"object"},
            "backend":{"kind":"script","interpreter":"python","path":"echo.py"}}]
    });
    let path = dir.join("echo.json");
    fs::write(&path, manifest.to_string())?;
    let manager = PluginManager::new(
        workspace.path(),
        HOST_PROCESS_PERMISSIONS.into_iter().collect(),
    );
    let limited = PluginManager::new(
        workspace.path(),
        BTreeSet::from([Capability::ReadFs, Capability::Subprocess]),
    );
    assert!(limited
        .discover()
        .unwrap_err()
        .to_string()
        .contains("permission"));

    let plugins = manager.discover()?;
    assert_eq!(plugins.len(), 1);
    let plugin = plugins.first().ok_or("missing echo plugin")?;
    assert_eq!(plugin.manifest().name, "echo");
    assert_eq!(
        plugin.invoke("echo_plugin", json!({"value":7})).await?,
        json!({"value":7})
    );
    let error = plugin
        .invoke("echo_plugin", json!({"fail":true}))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("script diagnostics"), "{error}");

    manifest
        .as_object_mut()
        .ok_or("expected object")?
        .insert("permissions".into(), json!(["read_fs", "subprocess"]));
    fs::write(path, manifest.to_string())?;
    assert!(manager
        .discover()
        .unwrap_err()
        .to_string()
        .contains("permission"));
    Ok(())
}

#[tokio::test]
async fn discovers_yaml_webhook_and_posts_json() -> Result<(), Box<dyn std::error::Error>> {
    let workspace = tempfile::tempdir()?;
    let dir = workspace.path().join(".lain/plugins");
    fs::create_dir_all(&dir)?;
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    fs::write(
        dir.join("mock.yaml"),
        format!(
            r#"
name: mock
version: 1.0.0
author: tests
permissions: [network]
tools:
  - name: mock_webhook
    description: Echo HTTP args
    parameters: {{type: object}}
    backend: {{kind: webhook, url: "http://{}/echo"}}
"#,
            listener.local_addr()?
        ),
    )?;
    assert!(PluginManager::new(workspace.path(), BTreeSet::new())
        .discover()?
        .is_empty());
    let manager = PluginManager::new(
        workspace.path(),
        BTreeSet::from([Capability::ReadFs, Capability::Network]),
    );
    let plugins = manager.discover()?;
    let plugin = plugins.first().ok_or("missing webhook plugin")?;
    let server = async {
        let (mut stream, _) = listener.accept().await?;
        let mut request = Vec::new();
        while !request.ends_with(b"{\"n\":1}") {
            if stream.read_buf(&mut request).await? == 0 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "incomplete test request",
                ));
            }
        }
        assert!(request.starts_with(b"POST /echo HTTP/1.1\r\n"));
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK")
            .await
    };
    let (result, sent) = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        tokio::join!(plugin.invoke("mock_webhook", json!({"n":1})), server)
    })
    .await?;
    sent?;
    assert_eq!(result?, json!({"status":200, "body":"OK"}));
    Ok(())
}

#[cfg(unix)]
#[tokio::test]
async fn cli_wrapper_sends_arguments_as_stdin() -> Result<(), Box<dyn std::error::Error>> {
    let workspace = tempfile::tempdir()?;
    let dir = workspace.path().join(".lain/plugins");
    fs::create_dir_all(&dir)?;
    fs::write(
        dir.join("cat.json"),
        json!({
            "name":"cat","version":"1.0.0","author":"tests",
            "permissions":["read_fs","write_fs","network","subprocess"],
            "tools":[{"name":"cat","description":"Echo JSON","parameters":{"type":"object"},
                "backend":{"kind":"cli","program":"/bin/cat"}}]
        })
        .to_string(),
    )?;
    let manager = PluginManager::new(
        workspace.path(),
        HOST_PROCESS_PERMISSIONS.into_iter().collect(),
    );
    let plugins = manager.discover()?;
    let result = plugins
        .first()
        .ok_or("missing CLI plugin")?
        .invoke("cat", json!({"x":"data"}))
        .await?;
    assert_eq!(result, json!({"stderr":"","stdout":"{\"x\":\"data\"}"}));
    Ok(())
}
