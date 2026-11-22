#![cfg(windows)]

use std::{os::windows::process::CommandExt, path::PathBuf, process::Stdio, time::Duration};

use lain_ipc::{Command, Endpoint, Event, IpcClient};
use tokio::{process::Command as ProcessCommand, time::timeout};

struct DaemonCleanup {
    exe: PathBuf,
    endpoint: PathBuf,
}

impl Drop for DaemonCleanup {
    fn drop(&mut self) {
        let Some(root) = std::env::var_os("SystemRoot") else {
            return;
        };
        let _ = std::process::Command::new(PathBuf::from(root).join(r"System32\WindowsPowerShell\v1.0\powershell.exe"))
            .args(["-NoProfile", "-NonInteractive", "-Command", concat!(
                "Get-CimInstance Win32_Process -Filter \"Name = 'lain handle test.exe'\" | ",
                "Where-Object { $_.ExecutablePath -eq $env:LAIN_TEST_EXE -and ",
                "$_.CommandLine.Contains($env:LAIN_TEST_ENDPOINT) } | ",
                "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
            )])
            .env("LAIN_TEST_EXE", &self.exe).env("LAIN_TEST_ENDPOINT", &self.endpoint)
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
            .creation_flags(0x08000000).status();
    }
}

#[tokio::test]
async fn windows_clients_reach_eof_before_daemon_exit() -> Result<(), Box<dyn std::error::Error>> {
    let directory = tempfile::Builder::new()
        .prefix("lain handles é ' ")
        .tempdir()?;
    let exe = directory.path().join("lain handle test.exe");
    std::fs::copy(env!("CARGO_BIN_EXE_lain"), &exe)?;
    let exe = std::fs::canonicalize(exe)?;
    let exe = PathBuf::from(
        exe.to_str()
            .ok_or("non-Unicode test path")?
            .trim_start_matches(r"\\?\"),
    );
    for (index, args) in [
        vec!["start"],
        vec!["query", "hi"],
        vec!["memory", "inspect"],
    ]
    .into_iter()
    .enumerate()
    {
        let endpoint =
            Endpoint(format!(r"\\.\pipe\lain-handle-eof-{}-{index}", std::process::id()).into());
        let _cleanup = DaemonCleanup {
            exe: exe.clone(),
            endpoint: endpoint.0.clone(),
        };
        let child = ProcessCommand::new(&exe)
            .args(&args)
            .arg("--endpoint")
            .arg(&endpoint.0)
            .arg("--plain")
            .current_dir(directory.path())
            .env("LAIN_CONFIG", "missing config 'é.json")
            .env("LAIN_MEMORY_DB", directory.path().join("memory.db"))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(0x08000000)
            .kill_on_drop(true)
            .spawn()?;
        let output = timeout(Duration::from_secs(12), child.wait_with_output()).await??;
        assert_eq!(
            output.status.success(),
            args.first() == Some(&"memory"),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        if args.first() != Some(&"memory") {
            assert!(String::from_utf8_lossy(&output.stderr).contains("CONFIG_NOT_FOUND"));
            assert!(String::from_utf8_lossy(&output.stderr).contains("missing config 'é.json"));
        }
        let mut client = IpcClient::connect(&endpoint).await?;
        assert!(matches!(
            client.request(Command::Ping).await?.as_slice(),
            [Event::Pong { .. }]
        ));
        client.close().await?;
    }
    Ok(())
}
