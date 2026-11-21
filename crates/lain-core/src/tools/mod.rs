use std::{
    collections::BTreeMap,
    path::PathBuf,
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};

use async_trait::async_trait;
use lain_memory::{MemoryStore, SearchOptions};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncReadExt};

use crate::provider::{CompletionResponse, Message, Role, ToolDefinition};

#[derive(Debug, thiserror::Error)]
pub enum ToolError {
    #[error("duplicate tool: {0}")]
    Duplicate(String),
    #[error("unknown tool: {0}")]
    Unknown(String),
    #[error("invalid schema: {0}")]
    Schema(String),
    #[error("invalid arguments: {0}")]
    Arguments(String),
    #[error("tool execution: {0}")]
    Execution(String),
    #[error("tool timed out")]
    Timeout,
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

#[derive(Default)]
pub struct ToolRegistry {
    tools: BTreeMap<String, RegisteredTool>,
}

impl std::fmt::Debug for ToolRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ToolRegistry")
            .field("names", &self.tools.keys())
            .finish()
    }
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, tool: Arc<dyn Tool>) -> Result<(), ToolError> {
        let name = tool.name().to_owned();
        if self.tools.contains_key(&name) {
            return Err(ToolError::Duplicate(name));
        }
        let parameters = tool.parameters_schema();
        let validator =
            jsonschema::validator_for(&parameters).map_err(|e| ToolError::Schema(e.to_string()))?;
        let definition = ToolDefinition {
            name: name.clone(),
            description: tool.description().into(),
            parameters,
        };
        self.tools.insert(
            name,
            RegisteredTool {
                tool,
                definition,
                validator,
            },
        );
        Ok(())
    }

    pub fn definitions(&self) -> Vec<ToolDefinition> {
        self.tools
            .values()
            .map(|entry| entry.definition.clone())
            .collect()
    }

    pub async fn dispatch(&self, name: &str, args: Value) -> Result<ToolOutput, ToolError> {
        let entry = self
            .tools
            .get(name)
            .ok_or_else(|| ToolError::Unknown(name.into()))?;
        entry
            .validator
            .validate(&args)
            .map_err(|e| ToolError::Arguments(e.to_string()))?;
        entry.tool.execute(args).await
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
            Ok(Ok((status, stdout, stderr))) => Ok(ToolOutput {
                content: json!({"stdout":stdout,"stderr":stderr}).to_string(),
                exit_code: status.code(),
            }),
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
