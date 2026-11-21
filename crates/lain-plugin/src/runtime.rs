use std::{
    env, fs,
    io::{self, Write},
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use reqwest::Url;
use serde_json::{json, Value};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::{Child, Command},
};

use crate::{manifest::ScriptInterpreter, PluginError};

const TIMEOUT: Duration = Duration::from_secs(30);
const BYTE_CAP: usize = 64 * 1024;

#[derive(Debug)]
pub(crate) enum Runtime {
    Script {
        interpreter: ScriptInterpreter,
        source: Vec<u8>,
    },
    Cli {
        program: PathBuf,
        args: Vec<String>,
    },
    Webhook(Url),
}

impl Runtime {
    pub(crate) async fn invoke(
        &self,
        workspace: &Path,
        name: &str,
        args: Value,
    ) -> Result<Value, PluginError> {
        match self {
            Self::Script {
                interpreter,
                source,
            } => {
                let script = tempfile::tempdir()?;
                let path = script
                    .path()
                    .join(format!("main.{}", interpreter.extension()));
                write_script(&path, *interpreter, source)?;
                let command = interpreter_command(*interpreter, &path)?;
                let result = process(
                    command,
                    workspace,
                    json!({"jsonrpc":"2.0","id":1,"method":name,"params":args}),
                    TIMEOUT,
                )
                .await?;
                decode_rpc(&result)
            }
            Self::Cli {
                program,
                args: fixed_args,
            } => {
                let mut command = clean_command(program);
                command.args(fixed_args);
                let result = process(command, workspace, args, TIMEOUT).await?;
                Ok(json!({"stdout":result.stdout,"stderr":result.stderr}))
            }
            Self::Webhook(url) => webhook(url, &args).await,
        }
    }
}

pub(crate) fn webhook_url(url: &str) -> Result<Url, PluginError> {
    let url = Url::parse(url).map_err(|e| PluginError::Invalid(format!("webhook URL: {e}")))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(PluginError::Invalid(
            "webhook URL must be HTTP(S) without credentials or fragments".into(),
        ));
    }
    Ok(url)
}

async fn webhook(url: &Url, args: &Value) -> Result<Value, PluginError> {
    let input = bounded_json(args)?;
    let error = |e: reqwest::Error| {
        if e.is_timeout() {
            PluginError::Timeout
        } else {
            PluginError::Execution(e.without_url().to_string())
        }
    };
    let client = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .build()
        .map_err(error)?;
    let mut response = client
        .post(url.clone())
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(input)
        .send()
        .await
        .map_err(error)?;
    if !response.status().is_success() {
        return Err(PluginError::Execution(format!(
            "webhook returned HTTP {}",
            response.status()
        )));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(error)? {
        if bytes.len() + chunk.len() > BYTE_CAP {
            return Err(PluginError::Execution(
                "webhook response exceeded 64 KiB".into(),
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(json!({"status":response.status().as_u16(),"body":String::from_utf8_lossy(&bytes)}))
}

fn write_script(path: &Path, interpreter: ScriptInterpreter, source: &[u8]) -> io::Result<()> {
    const UTF8_BOM: &[u8] = b"\xef\xbb\xbf";
    let mut file = fs::File::create(path)?;
    // Windows PowerShell reads an unmarked script using the local ANSI code page.
    if matches!(interpreter, ScriptInterpreter::Powershell) && !source.starts_with(UTF8_BOM) {
        file.write_all(UTF8_BOM)?;
    }
    file.write_all(source)
}

fn clean_command(program: &Path) -> Command {
    let mut command = Command::new(program);
    command.env_clear();
    #[cfg(windows)]
    if let Some(root) = env::var_os("SystemRoot") {
        command.env("SystemRoot", root);
    }
    command
}

fn interpreter_command(
    interpreter: ScriptInterpreter,
    script: &Path,
) -> Result<Command, PluginError> {
    let names: &[&str] = match (interpreter, cfg!(windows)) {
        (ScriptInterpreter::Python, false) => &["python3", "python"],
        (ScriptInterpreter::Python, true) => &["python.exe", "python3.exe"],
        (ScriptInterpreter::Powershell, false) => &["pwsh"],
        (ScriptInterpreter::Powershell, true) => &["pwsh.exe", "powershell.exe"],
        (ScriptInterpreter::Node, false) => &["node"],
        (ScriptInterpreter::Node, true) => &["node.exe"],
    };
    let paths = env::var_os("PATH").unwrap_or_default();
    let path = names
        .iter()
        .flat_map(|name| {
            env::split_paths(&paths)
                .filter(|path| path.is_absolute())
                .map(move |dir| dir.join(name))
        })
        .find(|path| path.is_file())
        .ok_or_else(|| {
            PluginError::Execution(format!("{interpreter:?} interpreter not found on PATH"))
        })?;
    let mut command = clean_command(&path);
    match interpreter {
        ScriptInterpreter::Python => command.arg("-I").arg(script),
        ScriptInterpreter::Node => command.arg(script),
        ScriptInterpreter::Powershell => command
            .env("LAIN_PLUGIN_SCRIPT", script)
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                concat!(
                    "[Console]::InputEncoding = [Console]::OutputEncoding = $OutputEncoding = [System.Text.UTF8Encoding]::new($false); ",
                    "& $env:LAIN_PLUGIN_SCRIPT; if (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE }; exit 1 }"
                ),
            ]),
    };
    Ok(command)
}

struct ProcessOutput {
    stdout: String,
    stderr: String,
    truncated: bool,
}

async fn collect(mut stream: impl AsyncRead + Unpin, bytes: &mut Vec<u8>) -> io::Result<bool> {
    let mut buf = [0; 8192];
    let mut truncated = false;
    loop {
        let n = stream.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        let count = n.min(BYTE_CAP - bytes.len());
        bytes.extend(buf.iter().take(count));
        truncated |= n > count;
    }
    Ok(truncated)
}

fn format_output(bytes: &[u8], truncated: bool) -> String {
    let mut text = String::from_utf8_lossy(bytes).into_owned();
    if truncated {
        text.push_str("\n[truncated]");
    }
    text
}

fn bounded_json(input: &Value) -> Result<String, PluginError> {
    let input = input.to_string();
    if input.len() > BYTE_CAP {
        return Err(PluginError::Execution(
            "plugin input exceeded 64 KiB".into(),
        ));
    }
    Ok(input)
}

struct ProcessTree {
    child: Child,
    active: bool,
    #[cfg(unix)]
    group: Option<u32>,
}

impl ProcessTree {
    fn spawn(command: &mut Command) -> io::Result<Self> {
        #[cfg(unix)]
        command.process_group(0);
        let child = command.spawn()?;
        Ok(Self {
            #[cfg(unix)]
            group: child.id(),
            child,
            active: true,
        })
    }
}

impl Drop for ProcessTree {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        #[cfg(unix)]
        if let Some(group) = self.group {
            let _ = std::process::Command::new("/bin/kill")
                .args(["-KILL", "--", &format!("-{group}")])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        #[cfg(windows)]
        if let (Some(pid), Some(root)) = (self.child.id(), env::var_os("SystemRoot")) {
            use std::os::windows::process::CommandExt;
            // taskkill needs the parent alive, so finish cleanup before the Child drop guard fires.
            let killer = PathBuf::from(root).join(r"System32\taskkill.exe");
            if let Ok(mut killer) = std::process::Command::new(killer)
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .creation_flags(0x08000000)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
            {
                let deadline = std::time::Instant::now() + Duration::from_secs(2);
                loop {
                    match killer.try_wait() {
                        Ok(Some(_)) => break,
                        _ if std::time::Instant::now() >= deadline => {
                            let _ = killer.kill();
                            let _ = killer.wait();
                            break;
                        }
                        _ => std::thread::sleep(Duration::from_millis(5)),
                    }
                }
            }
        }
    }
}

async fn process(
    mut command: Command,
    workspace: &Path,
    input: Value,
    timeout: Duration,
) -> Result<ProcessOutput, PluginError> {
    let input = bounded_json(&input)?;
    command
        .current_dir(workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut tree = ProcessTree::spawn(&mut command)?;
    let child = &mut tree.child;
    let (mut stdin, stdout, stderr) =
        match (child.stdin.take(), child.stdout.take(), child.stderr.take()) {
            (Some(stdin), Some(stdout), Some(stderr)) => (stdin, stdout, stderr),
            _ => {
                return Err(PluginError::Execution(
                    "plugin process is missing its pipes".into(),
                ))
            }
        };
    let write = async move {
        let result = stdin.write_all(input.as_bytes()).await;
        match result {
            Err(e) if e.kind() == io::ErrorKind::BrokenPipe => Ok(()),
            result => result,
        }
    };
    let (mut output, mut diagnostics) = (Vec::new(), Vec::new());
    let completion = tokio::time::timeout(timeout, async {
        let (_, stdout_truncated, stderr_truncated) = tokio::try_join!(
            write,
            collect(stdout, &mut output),
            collect(stderr, &mut diagnostics)
        )?;
        Ok::<_, io::Error>((child.wait().await?, stdout_truncated, stderr_truncated))
    })
    .await;
    let (status, truncated, stderr_truncated) = match completion {
        Ok(result) => result?,
        Err(_) if diagnostics.is_empty() => return Err(PluginError::Timeout),
        Err(_) => {
            return Err(PluginError::Execution(format!(
                "plugin timed out; stderr: {}",
                format_output(&diagnostics, diagnostics.len() == BYTE_CAP)
            )))
        }
    };
    tree.active = false;
    let stderr = format_output(&diagnostics, stderr_truncated);
    if !status.success() {
        return Err(PluginError::Execution(format!(
            "process exited with {status}; stderr: {stderr}"
        )));
    }
    Ok(ProcessOutput {
        stdout: format_output(&output, truncated),
        stderr,
        truncated,
    })
}

fn decode_rpc(output: &ProcessOutput) -> Result<Value, PluginError> {
    let fail =
        |message: &str| PluginError::Execution(format!("{message}; stderr: {}", output.stderr));
    if output.truncated {
        return Err(fail("JSON-RPC output exceeded 64 KiB"));
    }
    let response: Value = serde_json::from_str(&output.stdout)
        .map_err(|e| fail(&format!("invalid JSON-RPC response: {e}")))?;
    if response.get("jsonrpc") != Some(&json!("2.0")) || response.get("id") != Some(&json!(1)) {
        return Err(fail("unexpected JSON-RPC version or request ID"));
    }
    match (response.get("result"), response.get("error")) {
        (Some(result), None) => Ok(result.clone()),
        (None, Some(error)) => Err(fail(&format!("JSON-RPC error: {error}"))),
        _ => Err(fail(
            "JSON-RPC response must contain exactly one of result or error",
        )),
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn plugin_timeout_and_cancellation_kill_descendants(
    ) -> Result<(), Box<dyn std::error::Error>> {
        for cancel in [false, true] {
            let directory = tempfile::tempdir()?;
            let workspace = directory.path().to_owned();
            let pid_file = workspace.join("child.pid");
            let execution = tokio::spawn(async move {
                let mut command = Command::new("/bin/sh");
                command.args(["-c", "/bin/sleep 30 & echo $! > child.pid; wait"]);
                let timeout = if cancel {
                    TIMEOUT
                } else {
                    Duration::from_secs(1)
                };
                process(command, &workspace, json!({}), timeout).await
            });
            let pid = tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    if let Ok(text) = fs::read_to_string(&pid_file) {
                        if let Ok(pid) = text.trim().parse::<u32>() {
                            break pid;
                        }
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await?;
            if cancel {
                execution.abort();
                assert!(execution.await.is_err_and(|error| error.is_cancelled()));
            } else {
                assert!(matches!(execution.await?, Err(PluginError::Timeout)));
            }
            tokio::time::timeout(Duration::from_secs(2), async {
                loop {
                    match fs::read_to_string(format!("/proc/{pid}/status")) {
                        Ok(status)
                            if status.lines().any(|line| {
                                line.starts_with("State:") && line.contains("Z (zombie)")
                            }) =>
                        {
                            break
                        }
                        Ok(_) => tokio::time::sleep(Duration::from_millis(10)).await,
                        Err(error)
                            if error.kind() == io::ErrorKind::NotFound
                                || error.raw_os_error() == Some(3) =>
                        {
                            break
                        }
                        Err(error) => return Err(error),
                    }
                }
                Ok(())
            })
            .await??;
        }
        Ok(())
    }
}
