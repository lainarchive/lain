#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::{
    collections::BTreeMap,
    path::PathBuf,
    process::Stdio,
    sync::{Arc, Mutex, PoisonError, RwLock},
    time::Duration,
};

use async_trait::async_trait;
use lain_memory::{MemoryStore, SearchOptions};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncReadExt};

use crate::provider::{CompletionResponse, Message, Role, ToolDefinition};

mod creator;
mod plugins;
mod repo_map;

pub use creator::{CreateToolTool, TestToolTool};
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
    #[error("tool timed out")]
    Timeout,
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
            Self::Timeout => "TOOL_TIMEOUT",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ToolOutput {
    pub content: String,
    pub exit_code: Option<i32>,
}

#[async_trait]
pub trait Tool: Send + Sync {
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    fn parameters_schema(&self) -> Value;
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

    pub fn definitions(&self) -> Vec<ToolDefinition> {
        self.tools
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .values()
            .map(|entry| entry.definition.clone())
            .collect()
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

async fn read_capped(mut reader: impl AsyncRead + Unpin, cap: usize) -> std::io::Result<String> {
    let mut stored = Vec::new();
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
    let mut text = String::from_utf8_lossy(&stored).into_owned();
    while text.len() > cap {
        text.pop();
        truncated = true;
    }
    if truncated {
        text.push_str("\n[truncated]");
    }
    Ok(text)
}

#[async_trait]
impl Tool for BashTool {
    fn name(&self) -> &str {
        "bash"
    }
    fn description(&self) -> &str {
        "Run a bash command with host permissions"
    }
    fn parameters_schema(&self) -> Value {
        json!({"type":"object","properties":{"command":{"type":"string"}},"required":["command"],"additionalProperties":false})
    }
    async fn execute(&self, args: Value) -> Result<ToolOutput, ToolError> {
        let command = args
            .get("command")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::Arguments("command must be a string".into()))?;
        let mut child = tokio::process::Command::new("bash")
            .arg("-c")
            .arg(command)
            .current_dir(&self.working_directory)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| ToolError::Execution(e.to_string()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| ToolError::Execution("missing stdout".into()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| ToolError::Execution("missing stderr".into()))?;
        let result = tokio::time::timeout(self.timeout, async {
            tokio::try_join!(
                child.wait(),
                read_capped(stdout, self.output_byte_cap),
                read_capped(stderr, self.output_byte_cap)
            )
        })
        .await;
        match result {
            // No exit code means a signal ended the command. As `Ok` with `exit_code: None` it would read as success,
            // the same as a tool that has no exit code at all, so a caller counting failures would miss it.
            Ok(Ok((status, stdout, stderr))) => match status.code() {
                Some(code) => Ok(ToolOutput {
                    content: json!({"stdout":stdout,"stderr":stderr}).to_string(),
                    exit_code: Some(code),
                }),
                None => Err(ToolError::Execution(format!(
                    "command ended without an exit code ({status}); stderr: {stderr}"
                ))),
            },
            Ok(Err(error)) => Err(ToolError::Execution(error.to_string())),
            Err(_) => {
                child
                    .kill()
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Err(ToolError::Timeout)
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
    pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
    pub const MAX_TIMEOUT: Duration = Duration::from_secs(300);

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

fn powershell_tree_killer(pid: u32) -> std::process::Command {
    #[cfg(unix)]
    let mut command = {
        let mut command = std::process::Command::new("/bin/kill");
        command.args(["-KILL", "--", &format!("-{pid}")]);
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

struct PowerShellTreeGuard(Option<u32>);

impl Drop for PowerShellTreeGuard {
    fn drop(&mut self) {
        let Some(pid) = self.0 else {
            return;
        };
        // I finish tree cleanup before Child drops; taskkill needs the interpreter alive to find descendants.
        if let Ok(mut killer) = powershell_tree_killer(pid).spawn() {
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

async fn kill_powershell_tree(child: &mut tokio::process::Child, pid: Option<u32>) {
    if let Some(pid) = pid {
        #[cfg(windows)]
        if child.id() != Some(pid) {
            return;
        }
        let mut kill = tokio::process::Command::from(powershell_tree_killer(pid));
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
    let _ = child.kill().await;
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
        let timeout = match args.get("timeout_ms") {
            Some(value) => {
                Duration::from_millis(value.as_u64().filter(|value| *value > 0).ok_or_else(
                    || ToolError::Arguments("timeout_ms must be a positive integer".into()),
                )?)
            }
            None => self.timeout,
        }
        .min(Self::MAX_TIMEOUT);
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
        for key in ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"] {
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
        let mut tree_guard = PowerShellTreeGuard(pid);
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| ToolError::Execution("missing stdout".into()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| ToolError::Execution("missing stderr".into()))?;
        let result = tokio::time::timeout(timeout, async {
            tokio::try_join!(
                child.wait(),
                read_capped(stdout, self.output_byte_cap),
                read_capped(stderr, self.output_byte_cap)
            )
        })
        .await;
        match result {
            Ok(Ok((status, stdout, stderr))) => {
                tree_guard.0 = None;
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
                kill_powershell_tree(&mut child, pid).await;
                tree_guard.0 = None;
                Err(ToolError::Timeout)
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
