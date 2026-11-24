#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    path::PathBuf,
    process::Stdio,
    sync::{
        Arc, Mutex, PoisonError, RwLock,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use async_trait::async_trait;
use lain_memory::{MemoryStore, SearchOptions};
use lain_plugin::manifest::Capability;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

use crate::provider::{CompletionResponse, Message, Role, ToolDefinition};

mod creator;
mod plugins;
mod repo_map;

pub use creator::{
    CreateToolTool, CreatorReport, TestToolTool, publish_tool_proposal,
    publish_tool_proposal_checked, test_tool_proposal,
};
pub use repo_map::{REPO_MAP_TOOL_NAME, RepoMapTool};

pub const UPDATE_SCRATCHPAD_TOOL_NAME: &str = "UpdateScratchpad";

#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum ToolError {
    #[error("duplicate tool: {0}")]
    Duplicate(String),
    #[error("unknown tool: {0}")]
    Unknown(String),
    #[error("invalid schema: {0}")]
    Schema(String),
    #[error("invalid arguments: {0}")]
    Arguments(String),
    #[error("permission denied: {0}")]
    Permission(String),
    #[error("tool execution: {0}")]
    Execution(String),
    #[error("{0}")]
    Timeout(String),
}

fn tail(text: &str, bytes: usize) -> &str {
    let mut start = text.len().saturating_sub(bytes);
    while !text.is_char_boundary(start) {
        start += 1;
    }
    &text[start..]
}

/// Once the tree is dead the pipes reach EOF quickly; the deadline only guards against a detached
/// grandchild that inherited a pipe handle.
async fn drain_after_kill(
    stdout: &mut (impl AsyncRead + Unpin),
    stderr: &mut (impl AsyncRead + Unpin),
    cap: usize,
    out: &mut Vec<u8>,
    err: &mut Vec<u8>,
) {
    let _ = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(read_capped(stdout, cap, out), read_capped(stderr, cap, err))
    })
    .await;
}

/// A timed-out command reports what it emitted before it was killed, so the caller can tell slow
/// progress from a hang instead of retrying blindly.
fn timed_out_error(timeout: Duration, stdout: &str, stderr: &str) -> ToolError {
    let mut message = format!(
        "command timed out after {}ms and was killed",
        timeout.as_millis()
    );
    message.push_str("; rerun with a larger timeout_ms if it needs more time");
    if !stdout.is_empty() {
        message.push_str(&format!("; stdout tail: {}", tail(stdout, 2048)));
    }
    if !stderr.is_empty() {
        message.push_str(&format!("; stderr tail: {}", tail(stderr, 2048)));
    }
    ToolError::Timeout(message)
}

impl ToolError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Duplicate(_) => "TOOL_DUPLICATE",
            Self::Unknown(_) => "TOOL_NOT_FOUND",
            Self::Schema(_) => "TOOL_SCHEMA_INVALID",
            Self::Arguments(_) => "TOOL_ARGUMENTS_INVALID",
            Self::Permission(_) => "TOOL_PERMISSION_DENIED",
            Self::Execution(_) => "TOOL_EXECUTION_FAILED",
            Self::Timeout(_) => "TOOL_TIMEOUT",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, ts_rs::TS)]
pub struct ToolOutput {
    pub content: String,
    pub exit_code: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ToolSource {
    Builtin,
    Plugin {
        manifest_name: String,
        manifest_path: Option<PathBuf>,
    },
}

#[async_trait]
pub trait Tool: Send + Sync + std::any::Any {
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    fn parameters_schema(&self) -> Value;
    /// Display metadata only; read-only authorization still uses concrete tool identity.
    fn source(&self) -> ToolSource {
        ToolSource::Builtin
    }
    fn manifest_permissions(&self) -> Option<BTreeSet<Capability>> {
        None
    }
    async fn execute(&self, args: Value) -> Result<ToolOutput, ToolError>;
}

struct RegisteredTool {
    tool: Arc<dyn Tool>,
    definition: ToolDefinition,
    validator: jsonschema::Validator,
}

impl RegisteredTool {
    fn new(tool: Arc<dyn Tool>) -> Result<Self, ToolError> {
        let parameters = tool.parameters_schema();
        let validator =
            jsonschema::validator_for(&parameters).map_err(|e| ToolError::Schema(e.to_string()))?;
        let definition = ToolDefinition {
            name: tool.name().into(),
            description: tool.description().into(),
            parameters,
        };
        Ok(Self {
            tool,
            definition,
            validator,
        })
    }

    async fn dispatch(&self, args: Value) -> Result<ToolOutput, ToolError> {
        self.validator
            .validate(&args)
            .map_err(|e| ToolError::Arguments(e.to_string()))?;
        self.tool.execute(args).await
    }
}

#[derive(Default)]
pub struct ToolRegistry {
    tools: RwLock<BTreeMap<String, Arc<RegisteredTool>>>,
}

impl std::fmt::Debug for ToolRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let tools = self.tools.read().unwrap_or_else(PoisonError::into_inner);
        f.debug_struct("ToolRegistry")
            .field("names", &tools.keys())
            .finish()
    }
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, tool: Arc<dyn Tool>) -> Result<(), ToolError> {
        let name = tool.name().to_owned();
        let tools = self.tools.get_mut().unwrap_or_else(PoisonError::into_inner);
        if tools.contains_key(&name) {
            return Err(ToolError::Duplicate(name));
        }
        tools.insert(name, Arc::new(RegisteredTool::new(tool)?));
        Ok(())
    }

    fn register_batch<T>(
        &self,
        entries: Vec<RegisteredTool>,
        before_insert: impl FnOnce() -> Result<T, ToolError>,
    ) -> Result<T, ToolError> {
        let mut new = BTreeMap::new();
        for entry in entries {
            let name = entry.definition.name.clone();
            if name == UPDATE_SCRATCHPAD_TOOL_NAME
                || new.insert(name.clone(), Arc::new(entry)).is_some()
            {
                return Err(ToolError::Duplicate(name));
            }
        }
        let mut tools = self.tools.write().unwrap_or_else(PoisonError::into_inner);
        if let Some(name) = new.keys().find(|name| tools.contains_key(*name)) {
            return Err(ToolError::Duplicate(name.clone()));
        }
        let result = before_insert()?;
        tools.append(&mut new);
        Ok(result)
    }

    pub fn contains(&self, name: &str) -> bool {
        self.tools
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .contains_key(name)
    }

    pub fn is_builtin_read_only(&self, name: &str) -> bool {
        self.tools
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .get(name)
            .is_some_and(|entry| {
                let identity = entry.tool.as_ref().type_id();
                identity == std::any::TypeId::of::<MemoryReadTool>()
                    || identity == std::any::TypeId::of::<RepoMapTool>()
            })
    }

    pub fn definitions(&self) -> Vec<ToolDefinition> {
        self.tools
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .values()
            .map(|entry| entry.definition.clone())
            .collect()
    }

    pub fn source(&self, name: &str) -> Option<ToolSource> {
        self.tools
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .get(name)
            .map(|entry| entry.tool.source())
    }

    pub fn manifest_permissions(&self, name: &str) -> Option<BTreeSet<Capability>> {
        self.tools
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .get(name)
            .and_then(|entry| entry.tool.manifest_permissions())
    }

    pub async fn dispatch(&self, name: &str, args: Value) -> Result<ToolOutput, ToolError> {
        let entry = self
            .tools
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .get(name)
            .cloned()
            .ok_or_else(|| ToolError::Unknown(name.into()))?;
        entry.dispatch(args).await
    }

    pub async fn tool_messages(&self, response: &CompletionResponse) -> Vec<Message> {
        let mut messages = Vec::new();
        for call in &response.message.tool_calls {
            let content = match self.dispatch(&call.name, call.arguments.clone()).await {
                Ok(output) => json!(output).to_string(),
                Err(error) => json!({"error": error.to_string()}).to_string(),
            };
            messages.push(Message {
                role: Role::Tool,
                content: Some(content),
                tool_calls: Vec::new(),
                tool_call_id: Some(call.id.clone()),
                extra_content: None,
            });
        }
        messages
    }
}

/// Runs with the host user's permissions. This tool is not OS-sandboxed.
#[derive(Debug, Clone)]
pub struct BashTool {
    pub working_directory: PathBuf,
    pub timeout: Duration,
    pub output_byte_cap: usize,
}

pub const MAX_SHELL_TIMEOUT: Duration = Duration::from_secs(300);

fn shell_timeout(args: &Value, default: Duration) -> Result<Duration, ToolError> {
    let timeout = match args.get("timeout_ms") {
        Some(value) => {
            Duration::from_millis(value.as_u64().filter(|value| *value > 0).ok_or_else(|| {
                ToolError::Arguments("timeout_ms must be a positive integer".into())
            })?)
        }
        None => default,
    };
    Ok(timeout.min(MAX_SHELL_TIMEOUT))
}

// Accumulates into `stored` instead of returning the text so bytes read before a timeout still
// reach the caller after the read future is dropped. Returns whether output was cut by `cap`.
async fn read_capped(
    reader: &mut (impl AsyncRead + Unpin),
    cap: usize,
    stored: &mut Vec<u8>,
) -> std::io::Result<bool> {
    let mut buffer = [0; 8192];
    let mut truncated = false;
    loop {
        let count = reader.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        let take = count.min(cap.saturating_sub(stored.len()));
        stored.extend(buffer.iter().take(take));
        truncated |= take < count;
    }
    Ok(truncated)
}

fn capped_text(stored: &[u8], mut truncated: bool, cap: usize) -> String {
    let mut text = String::from_utf8_lossy(stored).into_owned();
    while text.len() > cap {
        text.pop();
        truncated = true;
    }
    if truncated {
        text.push_str("\n[truncated]");
    }
    text
}

/// Bytes kept from the end of an overflowing stream; the head keeps the rest of the cap.
const TAIL_KEEP: usize = 4096;

static SPILL_SEQ: AtomicU64 = AtomicU64::new(0);

struct Spill {
    file: tokio::fs::File,
    path: PathBuf,
    written: u64,
}

/// Names the file a stream's full output spills into, under the tool's working directory so the
/// model can read it back with its ordinary file tools.
fn spill_path(working_directory: &std::path::Path, stream: &str, pid: Option<u32>) -> PathBuf {
    let seq = SPILL_SEQ.fetch_add(1, Ordering::Relaxed);
    working_directory
        .join(".lain-tool-output")
        .join(format!("{stream}-{}-{seq}.log", pid.unwrap_or(0)))
}

/// Reads the whole stream, keeping the first `cap` bytes in `head` and the last `TAIL_KEEP` in
/// `tail`. Once the head is full the output spills to `path` so a truncation marker can point the
/// caller at the complete output instead of silently losing the middle — the failure mode where a
/// weak model hallucinates what it never saw.
/// Spill failures degrade to the old head-only marker: a missing file must not lose a run.
async fn read_spilled(
    reader: &mut (impl AsyncRead + Unpin),
    cap: usize,
    head: &mut Vec<u8>,
    tail: &mut VecDeque<u8>,
    spill: &mut Option<Spill>,
    path: &std::path::Path,
) -> std::io::Result<bool> {
    let mut buffer = [0; 8192];
    let mut truncated = false;
    loop {
        let count = reader.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        let take = count.min(cap.saturating_sub(head.len()));
        head.extend(buffer.iter().take(take));
        if take < count {
            truncated = true;
            let Some(overflow) = buffer.get(take..count) else {
                continue;
            };
            tail.extend(overflow.iter().copied());
            while tail.len() > TAIL_KEEP {
                tail.pop_front();
            }
            if let Some(s) = spill {
                if s.file.write_all(overflow).await.is_ok() {
                    s.written += overflow.len() as u64;
                }
            } else if let Some(dir) = path.parent()
                && tokio::fs::create_dir_all(dir).await.is_ok()
                && let Ok(mut file) = tokio::fs::File::create(path).await
                && file.write_all(head).await.is_ok()
                && file.write_all(overflow).await.is_ok()
            {
                *spill = Some(Spill {
                    file,
                    path: path.to_path_buf(),
                    written: (head.len() + overflow.len()) as u64,
                });
            }
        }
    }
    Ok(truncated)
}

/// Renders a spilled stream: head, a marker naming the byte count cut and the file holding the
/// full output, then the tail. Without a spill file the marker falls back to `[truncated]` but
/// the tail still prints, since the end of a long output is usually where the answer is.
fn spilled_text(
    head: &[u8],
    tail: &VecDeque<u8>,
    truncated: bool,
    spill: Option<&Spill>,
) -> String {
    let mut text = String::from_utf8_lossy(head).into_owned();
    if truncated {
        match spill {
            Some(s) => {
                let omitted = s.written.saturating_sub((head.len() + tail.len()) as u64);
                text.push_str(&format!(
                    "\n[... {omitted} bytes omitted; full output written to {} ...]\n",
                    s.path.display()
                ));
            }
            None => text.push_str("\n[truncated]\n"),
        }
        let tail_bytes: Vec<u8> = tail.iter().copied().collect();
        text.push_str(&String::from_utf8_lossy(&tail_bytes));
    }
    text
}

#[async_trait]
impl Tool for BashTool {
    fn name(&self) -> &str {
        "bash"
    }
    fn description(&self) -> &str {
        "Run a Bash command with host permissions. Each call starts a fresh shell; put directory changes and environment assignments inside command. The command is killed when its deadline passes; for work that may outlive it, run it in the background writing output to a file, then poll that file."
    }
    fn parameters_schema(&self) -> Value {
        json!({
            "type":"object",
            "properties":{
                "command":{"type":"string"},
                "timeout_ms":{"type":"integer","minimum":1,"description":"Optional deadline in milliseconds, capped at 300000."}
            },
            "required":["command"],
            "additionalProperties":false
        })
    }
    async fn execute(&self, args: Value) -> Result<ToolOutput, ToolError> {
        let script = args
            .get("command")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::Arguments("command must be a string".into()))?;
        let timeout = shell_timeout(&args, self.timeout)?;
        let mut command = tokio::process::Command::new("bash");
        command
            .arg("-c")
            .arg(script)
            .current_dir(&self.working_directory)
            .env_clear()
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        for key in [
            "PATH",
            "HOME",
            "USERPROFILE",
            "CARGO_HOME",
            "RUSTUP_HOME",
            "SystemRoot",
            "WINDIR",
            "PATHEXT",
            "TEMP",
            "TMP",
        ] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        #[cfg(unix)]
        command.process_group(0);
        let mut child = command
            .spawn()
            .map_err(|e| ToolError::Execution(e.to_string()))?;
        #[cfg(unix)]
        let mut tree_guard = ShellTreeGuard(child.id());
        let mut stdout = child
            .stdout
            .take()
            .ok_or_else(|| ToolError::Execution("missing stdout".into()))?;
        let mut stderr = child
            .stderr
            .take()
            .ok_or_else(|| ToolError::Execution("missing stderr".into()))?;
        let mut out_buf = Vec::new();
        let mut err_buf = Vec::new();
        let mut out_tail = VecDeque::new();
        let mut err_tail = VecDeque::new();
        let mut out_spill = None;
        let mut err_spill = None;
        let out_spill_path = spill_path(&self.working_directory, "stdout", child.id());
        let err_spill_path = spill_path(&self.working_directory, "stderr", child.id());
        let result = tokio::time::timeout(timeout, async {
            tokio::try_join!(
                child.wait(),
                read_spilled(
                    &mut stdout,
                    self.output_byte_cap,
                    &mut out_buf,
                    &mut out_tail,
                    &mut out_spill,
                    &out_spill_path,
                ),
                read_spilled(
                    &mut stderr,
                    self.output_byte_cap,
                    &mut err_buf,
                    &mut err_tail,
                    &mut err_spill,
                    &err_spill_path,
                )
            )
        })
        .await;
        match result {
            Ok(Ok((status, out_trunc, err_trunc))) => {
                #[cfg(unix)]
                {
                    tree_guard.0 = None;
                }
                // No exit code means a signal ended the command. As `Ok` with `exit_code: None` it would read as success,
                // the same as a tool that has no exit code at all, so a caller counting failures would miss it.
                let stdout = spilled_text(&out_buf, &out_tail, out_trunc, out_spill.as_ref());
                let stderr = spilled_text(&err_buf, &err_tail, err_trunc, err_spill.as_ref());
                match status.code() {
                    Some(code) => Ok(ToolOutput {
                        content: json!({"stdout":stdout,"stderr":stderr}).to_string(),
                        exit_code: Some(code),
                    }),
                    None => Err(ToolError::Execution(format!(
                        "command ended without an exit code ({status}); stderr: {stderr}"
                    ))),
                }
            }
            Ok(Err(error)) => Err(ToolError::Execution(error.to_string())),
            Err(_) => {
                #[cfg(unix)]
                {
                    kill_shell_tree(&mut child, tree_guard.0)
                        .await
                        .map_err(|e| ToolError::Execution(e.to_string()))?;
                    tree_guard.0 = None;
                }
                #[cfg(not(unix))]
                child
                    .kill()
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                drain_after_kill(
                    &mut stdout,
                    &mut stderr,
                    self.output_byte_cap,
                    &mut out_buf,
                    &mut err_buf,
                )
                .await;
                Err(timed_out_error(
                    timeout,
                    &capped_text(&out_buf, false, self.output_byte_cap),
                    &capped_text(&err_buf, false, self.output_byte_cap),
                ))
            }
        }
    }
}

#[derive(Debug, Clone)]
pub struct PowerShellTool {
    pub working_directory: PathBuf,
    pub timeout: Duration,
    pub output_byte_cap: usize,
    interpreter: Option<PathBuf>,
}

impl PowerShellTool {
    pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(300);
    pub const MAX_TIMEOUT: Duration = MAX_SHELL_TIMEOUT;

    pub fn new(working_directory: impl Into<PathBuf>) -> Self {
        Self {
            working_directory: working_directory.into(),
            timeout: Self::DEFAULT_TIMEOUT,
            output_byte_cap: 64 * 1024,
            interpreter: None,
        }
    }

    pub fn with_interpreter(
        working_directory: impl Into<PathBuf>,
        interpreter: impl Into<PathBuf>,
    ) -> Self {
        Self {
            interpreter: Some(interpreter.into()),
            ..Self::new(working_directory)
        }
    }

    pub fn interpreter(&self) -> Result<PathBuf, ToolError> {
        if let Some(path) = &self.interpreter {
            return std::fs::canonicalize(path).map_err(|error| {
                ToolError::Execution(format!(
                    "PowerShell interpreter {}: {error}",
                    path.display()
                ))
            });
        }
        #[cfg(windows)]
        let names = ["pwsh.exe", "powershell.exe"];
        #[cfg(not(windows))]
        let names = ["pwsh"];
        let path = std::env::var_os("PATH").unwrap_or_default();
        for name in names {
            for directory in std::env::split_paths(&path) {
                let candidate = directory.join(name);
                if !candidate.is_file() {
                    continue;
                }
                #[cfg(unix)]
                {
                    if !candidate
                        .metadata()
                        .is_ok_and(|metadata| metadata.permissions().mode() & 0o111 != 0)
                    {
                        continue;
                    }
                }
                return std::fs::canonicalize(&candidate)
                    .map_err(|error| ToolError::Execution(error.to_string()));
            }
        }
        Err(ToolError::Execution(format!(
            "PowerShell interpreter not found on PATH (tried {})",
            names.join(", ")
        )))
    }
}

fn shell_tree_killer(pid: u32) -> std::process::Command {
    #[cfg(unix)]
    let mut command = {
        let mut command = std::process::Command::new("/bin/sh");
        command.args(["-c", "kill -KILL -\"$1\"", "sh", &pid.to_string()]);
        command
    };
    #[cfg(windows)]
    let mut command = {
        use std::os::windows::process::CommandExt;
        // I use taskkill for the tree, but descendants can survive if their parent exits first; this is not a Windows Job Object.
        let mut command = std::process::Command::new("taskkill.exe");
        command.args(["/PID", &pid.to_string(), "/T", "/F"]);
        command.creation_flags(0x08000000);
        command
    };
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}

struct ShellTreeGuard(Option<u32>);

impl Drop for ShellTreeGuard {
    fn drop(&mut self) {
        let Some(pid) = self.0 else {
            return;
        };
        // I finish tree cleanup before Child drops; taskkill needs the interpreter alive to find descendants.
        if let Ok(mut killer) = shell_tree_killer(pid).spawn() {
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

async fn kill_shell_tree(
    child: &mut tokio::process::Child,
    pid: Option<u32>,
) -> std::io::Result<()> {
    if let Some(pid) = pid {
        #[cfg(windows)]
        if child.id() != Some(pid) {
            return Ok(());
        }
        let mut kill = tokio::process::Command::from(shell_tree_killer(pid));
        let _ = tokio::time::timeout(
            Duration::from_secs(2),
            kill.stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .kill_on_drop(true)
                .status(),
        )
        .await;
    }
    child.kill().await
}

#[async_trait]
impl Tool for PowerShellTool {
    fn name(&self) -> &str {
        "powershell"
    }

    fn description(&self) -> &str {
        "Run a PowerShell command with host permissions"
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type":"object",
            "properties":{"command":{"type":"string"},"timeout_ms":{"type":"integer","minimum":1}},
            "required":["command"],
            "additionalProperties":false
        })
    }

    async fn execute(&self, args: Value) -> Result<ToolOutput, ToolError> {
        let script = args
            .get("command")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::Arguments("command must be a string".into()))?;
        let timeout = shell_timeout(&args, self.timeout)?;
        // I force UTF-8 for Windows PowerShell's legacy code page, then parse separately so param/using statements still work.
        let script = format!(
            "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & ([scriptblock]::Create('{}'))",
            script.replace('\'', "''")
        );
        let mut command = tokio::process::Command::new(self.interpreter()?);
        command
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &script,
            ])
            .current_dir(&self.working_directory)
            .env_clear()
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        for key in [
            "PATH",
            "HOME",
            "USERPROFILE",
            "CARGO_HOME",
            "RUSTUP_HOME",
            "SystemRoot",
            "WINDIR",
            "PATHEXT",
            "TEMP",
            "TMP",
        ] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        #[cfg(unix)]
        command.process_group(0);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command
            .spawn()
            .map_err(|error| ToolError::Execution(error.to_string()))?;
        let pid = child.id();
        let mut tree_guard = ShellTreeGuard(pid);
        let mut stdout = child
            .stdout
            .take()
            .ok_or_else(|| ToolError::Execution("missing stdout".into()))?;
        let mut stderr = child
            .stderr
            .take()
            .ok_or_else(|| ToolError::Execution("missing stderr".into()))?;
        let mut out_buf = Vec::new();
        let mut err_buf = Vec::new();
        let mut out_tail = VecDeque::new();
        let mut err_tail = VecDeque::new();
        let mut out_spill = None;
        let mut err_spill = None;
        let out_spill_path = spill_path(&self.working_directory, "stdout", child.id());
        let err_spill_path = spill_path(&self.working_directory, "stderr", child.id());
        let result = tokio::time::timeout(timeout, async {
            tokio::try_join!(
                child.wait(),
                read_spilled(
                    &mut stdout,
                    self.output_byte_cap,
                    &mut out_buf,
                    &mut out_tail,
                    &mut out_spill,
                    &out_spill_path,
                ),
                read_spilled(
                    &mut stderr,
                    self.output_byte_cap,
                    &mut err_buf,
                    &mut err_tail,
                    &mut err_spill,
                    &err_spill_path,
                )
            )
        })
        .await;
        match result {
            Ok(Ok((status, out_trunc, err_trunc))) => {
                tree_guard.0 = None;
                let stdout = spilled_text(&out_buf, &out_tail, out_trunc, out_spill.as_ref());
                let stderr = spilled_text(&err_buf, &err_tail, err_trunc, err_spill.as_ref());
                match status.code() {
                    Some(code) => Ok(ToolOutput {
                        content: json!({"stdout":stdout,"stderr":stderr}).to_string(),
                        exit_code: Some(code),
                    }),
                    None => Err(ToolError::Execution(format!(
                        "command ended without an exit code ({status}); stderr: {stderr}"
                    ))),
                }
            }
            Ok(Err(error)) => Err(ToolError::Execution(error.to_string())),
            Err(_) => {
                let _ = kill_shell_tree(&mut child, pid).await;
                tree_guard.0 = None;
                drain_after_kill(
                    &mut stdout,
                    &mut stderr,
                    self.output_byte_cap,
                    &mut out_buf,
                    &mut err_buf,
                )
                .await;
                Err(timed_out_error(
                    timeout,
                    &capped_text(&out_buf, false, self.output_byte_cap),
                    &capped_text(&err_buf, false, self.output_byte_cap),
                ))
            }
        }
    }
}

#[derive(Debug, Clone)]
pub struct MemoryReadTool {
    store: Arc<Mutex<MemoryStore>>,
}

impl MemoryReadTool {
    pub fn new(store: Arc<Mutex<MemoryStore>>) -> Self {
        Self { store }
    }
}

#[async_trait]
impl Tool for MemoryReadTool {
    fn name(&self) -> &str {
        "memory_read"
    }
    fn description(&self) -> &str {
        "Search trusted, current memory by query, ranked by relevance then recency"
    }
    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "query": {"type": "string", "minLength": 1, "maxLength": 1000},
                "limit": {"type": "integer", "minimum": 1, "maximum": 100}
            },
            "required": ["query"],
            "additionalProperties": false
        })
    }
    async fn execute(&self, args: Value) -> Result<ToolOutput, ToolError> {
        let query = args
            .get("query")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::Arguments("query is required".into()))?;
        let limit = args
            .get("limit")
            .map(|v| {
                v.as_f64()
                    .filter(|v| v.fract() == 0.0 && (1.0..=100.0).contains(v))
                    .map(|v| v as i64)
                    .ok_or_else(|| ToolError::Arguments("limit must be 1..=100".into()))
            })
            .transpose()?
            .unwrap_or(10);
        let store = self.store.clone();
        let query = query.to_owned();
        let records = tokio::task::spawn_blocking(move || {
            store
                .lock()
                .map_err(|e| ToolError::Execution(e.to_string()))?
                .search(
                    &query,
                    SearchOptions {
                        limit,
                        include_untrusted: false,
                    },
                )
                .map_err(|e| ToolError::Execution(e.to_string()))
        })
        .await
        .map_err(|e| ToolError::Execution(e.to_string()))??;
        let records: Vec<Value> = records.into_iter().map(|r| json!({"id":r.id,"title":r.title,"content":r.content,"source":r.source,"trust":r.trust,"updated_at":r.updated_at})).collect();
        Ok(ToolOutput {
            content: Value::Array(records).to_string(),
            exit_code: None,
        })
    }
}
