use std::{
    io::{self, Write},
    net::SocketAddr,
    time::Duration,
};

use lain_agent::{AgentConfig, ProviderSelection};
use lain_ipc::{Command, Event, IpcClient, PROTOCOL_VERSION};
use serde::Serialize;

use crate::{args::Options, Error};
#[cfg(unix)]
use std::{os::unix::fs::FileTypeExt, path::Path};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum Level {
    Pass,
    Warning,
    Fail,
}

#[derive(Debug, Serialize)]
struct Check {
    name: String,
    level: Level,
    detail: String,
}

impl Check {
    fn new(name: impl Into<String>, level: Level, detail: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            level,
            detail: detail.into(),
        }
    }
}

fn http_client() -> Result<reqwest::Client, Error> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(1))
        .connect_timeout(Duration::from_secs(1))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| Error::failure("DOCTOR_HTTP", "Cannot build diagnostic HTTP client"))
}

async fn model_checks(
    client: &reqwest::Client,
    provider: &ProviderSelection,
    lookup: &impl Fn(&str) -> Option<std::ffi::OsString>,
) -> Vec<Check> {
    let ProviderSelection::OpenAiCompatible {
        base_url,
        api_key_env,
    } = provider
    else {
        return vec![Check::new(
            "models",
            Level::Warning,
            "Provider diagnostics are unavailable for this provider",
        )];
    };
    let mut checks = vec![];
    if let Some(name) = api_key_env {
        let valid = !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
        let present = valid && lookup(name).is_some_and(|value| !value.is_empty());
        checks.push(Check::new(
            "API key",
            if present { Level::Pass } else { Level::Fail },
            format!(
                "{}: {}",
                if valid {
                    name.as_str()
                } else {
                    "invalid environment variable name"
                },
                if present {
                    "present (value hidden)"
                } else {
                    "missing"
                }
            ),
        ));
    }
    let Ok(mut url) = reqwest::Url::parse(base_url) else {
        checks.push(Check::new(
            "model endpoint",
            Level::Fail,
            "Invalid configured URL",
        ));
        return checks;
    };
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        checks.push(Check::new(
            "model endpoint",
            Level::Fail,
            "URL must be HTTP(S), without embedded credentials, query or fragment",
        ));
        return checks;
    }
    let local = url.host_str().is_some_and(|h| {
        h == "localhost"
            || h.parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
            || h == "[::1]"
    });
    if !local && api_key_env.is_none() {
        checks.push(Check::new(
            "API key",
            Level::Warning,
            "No API key environment variable configured",
        ));
    }
    let name = format!("{} model endpoint", if local { "local" } else { "remote" });
    let path = format!("{}/models", url.path().trim_end_matches('/'));
    url.set_path(&path);
    let check = match client.get(url).send().await {
        Ok(response) if response.status().is_success() => {
            Check::new(name, Level::Pass, "Configured models route reachable")
        }
        Ok(response)
            if matches!(response.status().as_u16(), 401 | 403) && api_key_env.is_some() =>
        {
            Check::new(
                name,
                Level::Warning,
                "Endpoint reachable; authentication required (keys were not transmitted)",
            )
        }
        Ok(response) => Check::new(
            name,
            Level::Fail,
            format!("Models route returned HTTP {}", response.status().as_u16()),
        ),
        Err(_) => Check::new(
            name,
            Level::Fail,
            "Models route unreachable or timed out (1 s limit)",
        ),
    };
    checks.push(check);
    checks
}

async fn port_check(client: &reqwest::Client, address: SocketAddr) -> Check {
    let name = format!("dashboard {address}");
    if let Ok(listener) = tokio::net::TcpListener::bind(address).await {
        drop(listener);
        return Check::new(name, Level::Pass, "Free");
    }
    let probe = async {
        let mut response = client
            .get(format!("http://{address}/healthz"))
            .send()
            .await
            .ok()?;
        if !response.status().is_success() {
            return None;
        }
        let mut body = vec![];
        while let Some(chunk) = response.chunk().await.ok()? {
            if body.len() + chunk.len() > 4096 {
                return None;
            }
            body.extend_from_slice(&chunk);
        }
        let value: serde_json::Value = serde_json::from_slice(&body).ok()?;
        (value.get("service").and_then(|s| s.as_str()) == Some("lain")
            && value.get("protocol_version").and_then(|v| v.as_u64())
                == Some(u64::from(PROTOCOL_VERSION)))
        .then_some(())
    };
    if probe.await.is_some() {
        Check::new(name, Level::Pass, "Served by lain (health response)")
    } else {
        Check::new(
            name,
            Level::Fail,
            "Occupied by another service or an unresponsive/older daemon",
        )
    }
}

async fn ipc_check(endpoint: &lain_ipc::Endpoint) -> Check {
    let ping = async {
        let mut client = IpcClient::connect(endpoint).await?;
        let response = client.request(Command::Ping).await?;
        client.close().await?;
        Ok::<_, lain_ipc::Error>(response)
    };
    if let Ok(Ok(events)) = tokio::time::timeout(Duration::from_millis(500), ping).await {
        return if matches!(events.as_slice(),[Event::Pong {server_version}] if *server_version==PROTOCOL_VERSION)
        {
            Check::new(
                "IPC",
                Level::Pass,
                format!("Daemon reachable · protocol {PROTOCOL_VERSION}"),
            )
        } else {
            Check::new(
                "IPC",
                Level::Fail,
                "Daemon Ping returned an incompatible protocol response",
            )
        };
    }
    #[cfg(unix)]
    let creatable = {
        if let Ok(metadata) = std::fs::symlink_metadata(&endpoint.0) {
            let detail = if metadata.file_type().is_socket() {
                "Existing socket is unresponsive; left untouched"
            } else {
                "Endpoint exists and is not a socket"
            };
            return Check::new("IPC", Level::Fail, detail);
        }
        let parent = endpoint
            .0
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        let mut bytes = [0; 8];
        if getrandom::fill(&mut bytes).is_err() {
            return Check::new(
                "IPC",
                Level::Fail,
                "Cannot generate a safe socket probe name",
            );
        }
        let path = parent.join(format!(".lain-doctor-{:x}.sock", u64::from_ne_bytes(bytes)));
        match std::os::unix::net::UnixListener::bind(&path) {
            Ok(listener) => {
                drop(listener);
                let _ = std::fs::remove_file(path);
                true
            }
            Err(_) => false,
        }
    };
    #[cfg(windows)]
    let creatable = lain_ipc::IpcServer::bind(endpoint).is_ok();
    if creatable {
        Check::new(
            "IPC",
            Level::Warning,
            "Daemon absent; endpoint can be created (no daemon started)",
        )
    } else {
        Check::new(
            "IPC",
            Level::Fail,
            "Daemon absent; endpoint cannot be created",
        )
    }
}

fn version(value: &str) -> Option<(u32, u32, u32)> {
    let mut parts = value.trim().split('.');
    Some((
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts
            .next()
            .unwrap_or("0")
            .split('-')
            .next()?
            .parse()
            .ok()?,
    ))
}

fn minimum() -> Option<String> {
    for (file, key) in [
        ("rust-toolchain.toml", "channel"),
        ("Cargo.toml", "rust-version"),
    ] {
        if let Ok(text) = std::fs::read_to_string(file) {
            for line in text.lines() {
                if let Some((name, value)) = line.split_once('=') {
                    let value = value.trim().trim_matches('"');
                    if name.trim() == key && version(value).is_some() {
                        return Some(value.into());
                    }
                }
            }
        }
    }
    let packaged = env!("CARGO_PKG_RUST_VERSION");
    (!packaged.is_empty()).then(|| packaged.into())
}

async fn toolchain(tool: &str, min: Option<&str>) -> Check {
    let mut command = tokio::process::Command::new(tool);
    command
        .arg("--version")
        .env("RUSTUP_AUTO_INSTALL", "0")
        .kill_on_drop(true);
    let Ok(Ok(output)) = tokio::time::timeout(Duration::from_secs(2), command.output()).await
    else {
        return Check::new(
            tool,
            Level::Fail,
            "Not installed, unavailable or timed out (2 s limit)",
        );
    };
    if !output.status.success() {
        return Check::new(tool, Level::Fail, "Version command failed");
    }
    let output = String::from_utf8_lossy(&output.stdout);
    let actual = output.split_whitespace().nth(1).and_then(version);
    if !output.is_empty()
        && actual.is_some()
        && min
            .and_then(version)
            .is_none_or(|required| actual.is_some_and(|current| current >= required))
    {
        Check::new(
            tool,
            Level::Pass,
            format!(
                "{} · {}",
                output.trim(),
                min.map(|m| format!("minimum {m}"))
                    .unwrap_or_else(|| "minimum not declared".into())
            ),
        )
    } else {
        Check::new(
            tool,
            Level::Fail,
            "Cannot read version, or below declared minimum",
        )
    }
}

pub async fn execute(options: &Options) -> Result<u8, Error> {
    let client = http_client()?;
    let min = minimum();
    let mut checks = vec![
        toolchain("rustc", min.as_deref()).await,
        toolchain("cargo", min.as_deref()).await,
        ipc_check(&options.endpoint).await,
        port_check(&client, SocketAddr::from(([127, 0, 0, 1], 4040))).await,
    ];
    match std::fs::read(&options.config)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<AgentConfig>(&bytes).ok())
    {
        Some(config) => match config.validate() {
            Ok(()) => checks.extend(
                model_checks(&client, &config.provider, &|name| std::env::var_os(name)).await,
            ),
            Err(error) => checks.push(Check::new("model config", Level::Fail, error.to_string())),
        },
        None => checks.push(Check::new(
            "model config",
            Level::Fail,
            "Cannot read or parse the configured AgentConfig JSON",
        )),
    }
    let passed = checks.iter().filter(|c| c.level == Level::Pass).count();
    let warnings = checks.iter().filter(|c| c.level == Level::Warning).count();
    let failed = checks.iter().filter(|c| c.level == Level::Fail).count();
    let mut out = io::stdout().lock();
    if options.json {
        writeln!(
            out,
            "{}",
            serde_json::to_string_pretty(
                &serde_json::json!({"checks":checks,"summary":{"passed":passed,"warnings":warnings,"failed":failed}})
            )?
        )?;
    } else {
        for check in checks {
            let mark = match check.level {
                Level::Pass => "✓",
                Level::Warning => "!",
                Level::Fail => "✗",
            };
            writeln!(
                out,
                "{mark} {}: {}",
                crate::render::clean(&check.name),
                crate::render::clean(&check.detail)
            )?;
        }
        writeln!(
            out,
            "Summary: {passed} passed · {warnings} warnings · {failed} failed"
        )?;
    }
    Ok(if failed > 0 { 1 } else { 0 })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn toolchain_versions_fail_when_missing_or_below_minimum() {
        assert_eq!(version("1.88"), Some((1, 88, 0)));
        assert_eq!(version("stable"), None);
        assert_eq!(toolchain("rustc", Some("999.0.0")).await.level, Level::Fail);
        assert_eq!(
            toolchain("lain-doctor-missing-tool", None).await.level,
            Level::Fail
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn ipc_probes_creation_ping_and_protocol_without_starting_a_daemon(
    ) -> Result<(), Box<dyn std::error::Error>> {
        struct Ping(u32);
        impl lain_ipc::CommandHandler for Ping {
            fn handle(
                &self,
                _: Command,
                events: lain_ipc::EventSink,
            ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
                Box::pin(async move {
                    let _ = events
                        .send(Event::Pong {
                            server_version: self.0,
                        })
                        .await;
                })
            }
        }
        let directory = tempfile::tempdir()?;
        let endpoint = lain_ipc::Endpoint(directory.path().join("ipc.sock"));
        assert_eq!(ipc_check(&endpoint).await.level, Level::Warning);
        assert_eq!(std::fs::read_dir(directory.path())?.count(), 0);
        std::fs::write(&endpoint.0, "occupied")?;
        assert_eq!(ipc_check(&endpoint).await.level, Level::Fail);
        std::fs::remove_file(&endpoint.0)?;
        for (protocol, expected) in [
            (PROTOCOL_VERSION, Level::Pass),
            (PROTOCOL_VERSION + 1, Level::Fail),
        ] {
            let (stop, receiver) = tokio::sync::watch::channel(false);
            let server = tokio::spawn(
                lain_ipc::IpcServer::bind(&endpoint)?
                    .serve(std::sync::Arc::new(Ping(protocol)), receiver),
            );
            assert_eq!(ipc_check(&endpoint).await.level, expected);
            stop.send(true)?;
            server.await??;
        }
        Ok(())
    }

    async fn fake(
        status: u16,
        body: &str,
    ) -> Result<std::net::SocketAddr, Box<dyn std::error::Error>> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let body = body.to_owned();
        tokio::spawn(async move {
            if let Ok((mut socket, _)) = listener.accept().await {
                let mut request = [0; 2048];
                let _ = socket.read(&mut request).await;
                let response=format!("HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
                let _ = socket.write_all(response.as_bytes()).await;
            }
        });
        Ok(address)
    }

    #[tokio::test]
    async fn distinguishes_free_lain_and_foreign_ports() -> Result<(), Box<dyn std::error::Error>> {
        let client = http_client()?;
        let lain = fake(
            200,
            &format!(
                "{{\"service\":\"lain\",\"protocol_version\":{}}}",
                lain_ipc::PROTOCOL_VERSION
            ),
        )
        .await?;
        assert_eq!(port_check(&client, lain).await.level, Level::Pass);
        let foreign = fake(200, "not lain").await?;
        assert_eq!(port_check(&client, foreign).await.level, Level::Fail);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let free = listener.local_addr()?;
        drop(listener);
        assert_eq!(port_check(&client, free).await.level, Level::Pass);
        Ok(())
    }

    #[tokio::test]
    async fn model_checks_are_bounded_and_never_print_key_values(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let client = http_client()?;
        let address = fake(200, "{}").await?;
        let provider = lain_agent::ProviderSelection::OpenAiCompatible {
            base_url: format!("http://{address}/v1"),
            api_key_env: Some("TEST_API_KEY".into()),
        };
        let checks =
            model_checks(&client, &provider, &|_| Some("secret-canary-value".into())).await;
        assert!(checks.iter().all(|c| c.level == Level::Pass));
        let output = serde_json::to_string(&checks)?;
        assert!(!output.contains("secret-canary-value"));
        assert!(output.contains("TEST_API_KEY"));
        let address = fake(401, "{}").await?;
        let provider = lain_agent::ProviderSelection::OpenAiCompatible {
            base_url: format!("http://{address}/v1"),
            api_key_env: Some("MISSING_KEY".into()),
        };
        assert!(model_checks(&client, &provider, &|_| None)
            .await
            .iter()
            .any(|c| c.level == Level::Fail));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let provider = lain_agent::ProviderSelection::OpenAiCompatible {
            base_url: format!("http://{}", listener.local_addr()?),
            api_key_env: None,
        };
        let checks = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            model_checks(&client, &provider, &|_| None),
        )
        .await?;
        assert!(checks.iter().any(|c| c.level == Level::Fail));
        let provider = lain_agent::ProviderSelection::OpenAiCompatible {
            base_url: "http://user:secret-canary-value@localhost/?token=secret-canary-value".into(),
            api_key_env: None,
        };
        assert!(
            !serde_json::to_string(&model_checks(&client, &provider, &|_| None).await)?
                .contains("secret-canary-value")
        );
        Ok(())
    }
}
