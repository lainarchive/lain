#![cfg(target_os = "linux")]

use std::{os::unix::ffi::OsStrExt, path::PathBuf, process::Stdio, time::Duration};

use lain_ipc::{Command, Endpoint, Event, IpcClient};
use tokio::{process::Command as ProcessCommand, time::timeout};

struct DaemonCleanup(PathBuf);

impl Drop for DaemonCleanup {
    fn drop(&mut self) {
        let Ok(entries) = std::fs::read_dir("/proc") else {
            return;
        };
        for entry in entries.flatten() {
            let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
                continue;
            };
            let Ok(command) = std::fs::read(entry.path().join("cmdline")) else {
                continue;
            };
            let args: Vec<_> = command.split(|byte| *byte == 0).collect();
            if args.get(1).is_some_and(|arg| *arg == b"daemon")
                && args.iter().any(|arg| *arg == self.0.as_os_str().as_bytes())
            {
                let _ = std::process::Command::new("/bin/kill")
                    .args(["-INT", &pid.to_string()])
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
            }
        }
    }
}

#[tokio::test]
async fn clients_reach_output_eof_while_spawned_daemon_is_alive()
-> Result<(), Box<dyn std::error::Error>> {
    for args in [
        vec!["start"],
        vec!["query", "hi"],
        vec!["memory", "inspect"],
    ] {
        let directory = tempfile::tempdir()?;
        let endpoint = Endpoint(directory.path().join("ipc.sock"));
        let cleanup = DaemonCleanup(endpoint.0.clone());
        let child = ProcessCommand::new(env!("CARGO_BIN_EXE_lain"))
            .args(&args)
            .arg("--endpoint")
            .arg(&endpoint.0)
            .arg("--plain")
            .current_dir(directory.path())
            .env("LAIN_CONFIG", directory.path().join("missing.json"))
            .env("LAIN_MEMORY_DB", directory.path().join("memory.db"))
            .env("XDG_STATE_HOME", directory.path().join("state"))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;
        let output = timeout(Duration::from_secs(8), child.wait_with_output()).await??;
        assert_eq!(output.status.success(), args.first() == Some(&"memory"));
        let mut client = IpcClient::connect(&endpoint).await?;
        assert!(matches!(
            client.request(Command::Ping).await?.as_slice(),
            [Event::Pong { .. }]
        ));
        timeout(Duration::from_secs(3), async {
            loop {
                let logs = std::fs::read_dir(directory.path().join("state/lain"))?
                    .map(|entry| std::fs::read_to_string(entry?.path()))
                    .collect::<Result<Vec<_>, std::io::Error>>()?
                    .join("\n");
                match client.request(Command::GetDashboardUrl).await?.as_slice() {
                    [Event::DashboardUrl { url }]
                        if url.as_ref().is_some_and(|url| logs.contains(url))
                            || (url.is_none() && logs.contains("continuing with IPC only")) =>
                    {
                        break Ok::<_, Box<dyn std::error::Error>>(());
                    }
                    _ => {}
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await??;
        client.close().await?;
        drop(cleanup);
        timeout(Duration::from_secs(3), async {
            while endpoint.0.exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await?;
    }
    Ok(())
}
