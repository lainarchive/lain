use std::time::{Duration, SystemTime};

use async_trait::async_trait;
use futures::{StreamExt, stream::BoxStream};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::CoreError;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
    Tool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Message {
    pub role: Role,
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCall>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    // Gemini's OpenAI-compat layer puts thought_signature here and on each tool
    // call, then refuses the next turn with 400 when it comes back missing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extra_content: Option<Value>,
}

impl Message {
    pub fn text(role: Role, content: impl Into<String>) -> Self {
        Self {
            role,
            content: Some(content.into()),
            tool_calls: Vec::new(),
            tool_call_id: None,
            extra_content: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(into = "WireDefinition", try_from = "WireDefinition")]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WireDefinition {
    #[serde(rename = "type")]
    kind: String,
    function: DefinitionFunction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DefinitionFunction {
    name: String,
    description: String,
    parameters: Value,
}

impl From<ToolDefinition> for WireDefinition {
    fn from(value: ToolDefinition) -> Self {
        Self {
            kind: "function".into(),
            function: DefinitionFunction {
                name: value.name,
                description: value.description,
                parameters: value.parameters,
            },
        }
    }
}

impl TryFrom<WireDefinition> for ToolDefinition {
    type Error = String;
    fn try_from(value: WireDefinition) -> Result<Self, Self::Error> {
        if value.kind != "function" {
            return Err("unsupported tool type".into());
        }
        Ok(Self {
            name: value.function.name,
            description: value.function.description,
            parameters: value.function.parameters,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(into = "WireCall", try_from = "WireCall")]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extra_content: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WireCall {
    id: String,
    #[serde(rename = "type")]
    kind: String,
    function: CallFunction,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    extra_content: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CallFunction {
    name: String,
    arguments: String,
}

impl From<ToolCall> for WireCall {
    fn from(value: ToolCall) -> Self {
        Self {
            id: value.id,
            kind: "function".into(),
            function: CallFunction {
                name: value.name,
                arguments: value.arguments.to_string(),
            },
            extra_content: value.extra_content,
        }
    }
}

impl TryFrom<WireCall> for ToolCall {
    type Error = String;
    fn try_from(value: WireCall) -> Result<Self, Self::Error> {
        if value.kind != "function" {
            return Err("unsupported tool call type".into());
        }
        Ok(Self {
            id: value.id,
            name: value.function.name,
            arguments: serde_json::from_str(&value.function.arguments)
                .map_err(|e| e.to_string())?,
            extra_content: value.extra_content,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompletionRequest {
    pub model: String,
    pub messages: Vec<Message>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<ToolDefinition>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompletionResponse {
    pub message: Message,
    pub finish_reason: Option<String>,
    pub usage: Option<Usage>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Usage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Token {
    Usage(Usage),
    Text(String),
    ToolCall {
        index: usize,
        id: Option<String>,
        name: Option<String>,
        arguments: Option<String>,
        extra_content: Option<Value>,
    },
    // Message-level extras (e.g. Gemini thought_signature) that must round-trip.
    ExtraContent(Value),
    Finished(String),
}

#[async_trait]
pub trait ModelProvider: Send + Sync {
    async fn complete(&self, req: CompletionRequest) -> Result<CompletionResponse, CoreError>;
    async fn stream(
        &self,
        req: CompletionRequest,
    ) -> Result<BoxStream<'static, Result<Token, CoreError>>, CoreError>;
}

#[derive(Clone)]
pub struct OpenAiCompatibleProvider {
    client: reqwest::Client,
    base_url: String,
    api_key: Option<String>,
    timeout: Duration,
}

impl std::fmt::Debug for OpenAiCompatibleProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OpenAiCompatibleProvider")
            .finish_non_exhaustive()
    }
}

impl OpenAiCompatibleProvider {
    pub fn new(base_url: impl Into<String>, api_key: Option<String>) -> Self {
        Self {
            client: reqwest::Client::new(),
            base_url: base_url.into(),
            api_key,
            timeout: Duration::from_secs(120),
        }
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    async fn send(
        &self,
        req: CompletionRequest,
        stream: bool,
    ) -> Result<reqwest::Response, CoreError> {
        #[derive(Serialize)]
        struct WireRequest {
            #[serde(flatten)]
            request: CompletionRequest,
            stream: bool,
            #[serde(skip_serializing_if = "Option::is_none")]
            stream_options: Option<Value>,
        }
        let body = WireRequest {
            request: req,
            stream,
            stream_options: stream.then(|| serde_json::json!({"include_usage":true})),
        };
        let mut request = self
            .client
            .post(format!(
                "{}/chat/completions",
                self.base_url.trim_end_matches('/')
            ))
            .json(&body)
            .timeout(self.timeout);
        if let Some(key) = &self.api_key {
            request = request.bearer_auth(key);
        }
        let response = request.send().await?;
        if !response.status().is_success() {
            let retry_after = response
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| {
                    value.parse().ok().map(Duration::from_secs).or_else(|| {
                        let date = httpdate::parse_http_date(value).ok()?;
                        Some(date.duration_since(SystemTime::now()).unwrap_or_default())
                    })
                });
            return Err(CoreError::Status {
                status: response.status().as_u16(),
                body: response
                    .text()
                    .await
                    .unwrap_or_else(|error| error.to_string()),
                retry_after,
            });
        }
        Ok(response)
    }
}

#[derive(Deserialize)]
struct Envelope {
    choices: Vec<Choice>,
    usage: Option<Usage>,
}
#[derive(Deserialize)]
struct Choice {
    message: Message,
    finish_reason: Option<String>,
}

#[derive(Deserialize)]
struct StreamEnvelope {
    choices: Vec<StreamChoice>,
    usage: Option<Usage>,
}
#[derive(Deserialize)]
struct StreamChoice {
    delta: Delta,
    finish_reason: Option<String>,
}
#[derive(Deserialize)]
struct Delta {
    content: Option<String>,
    #[serde(default)]
    tool_calls: Vec<CallDelta>,
    extra_content: Option<Value>,
}
#[derive(Deserialize)]
struct CallDelta {
    // Gemini's stream omits index on the first call.
    #[serde(default)]
    index: usize,
    id: Option<String>,
    function: Option<FunctionDelta>,
    extra_content: Option<Value>,
}
#[derive(Deserialize)]
struct FunctionDelta {
    name: Option<String>,
    arguments: Option<String>,
}

fn parse_event(data: &str) -> Result<Vec<Token>, CoreError> {
    let event: StreamEnvelope = serde_json::from_str(data)?;
    let mut tokens = Vec::new();
    if let Some(usage) = event.usage {
        tokens.push(Token::Usage(usage));
    }
    for choice in event.choices {
        if let Some(text) = choice.delta.content {
            tokens.push(Token::Text(text));
        }
        for call in choice.delta.tool_calls {
            let (name, arguments) = call
                .function
                .map(|f| (f.name, f.arguments))
                .unwrap_or_default();
            tokens.push(Token::ToolCall {
                index: call.index,
                id: call.id,
                name,
                arguments,
                extra_content: call.extra_content,
            });
        }
        if let Some(extra) = choice.delta.extra_content {
            tokens.push(Token::ExtraContent(extra));
        }
        if let Some(reason) = choice.finish_reason {
            tokens.push(Token::Finished(reason));
        }
    }
    Ok(tokens)
}

#[derive(Default)]
struct SseLines {
    pending: Vec<u8>,
    skip_lf: bool,
}

impl SseLines {
    fn push(&mut self, chunk: &[u8]) -> Vec<Vec<u8>> {
        let mut lines = Vec::new();
        for &byte in chunk {
            if self.skip_lf && byte == b'\n' {
                self.skip_lf = false;
                continue;
            }
            self.skip_lf = byte == b'\r';
            if byte == b'\r' || byte == b'\n' {
                lines.push(std::mem::take(&mut self.pending));
            } else {
                self.pending.push(byte);
            }
        }
        lines
    }
}

#[async_trait]
impl ModelProvider for OpenAiCompatibleProvider {
    async fn complete(&self, req: CompletionRequest) -> Result<CompletionResponse, CoreError> {
        let envelope: Envelope =
            serde_json::from_slice(&self.send(req, false).await?.bytes().await?)?;
        let choice = envelope
            .choices
            .into_iter()
            .next()
            .ok_or_else(|| CoreError::Protocol("missing choice".into()))?;
        Ok(CompletionResponse {
            message: choice.message,
            finish_reason: choice.finish_reason,
            usage: envelope.usage,
        })
    }

    async fn stream(
        &self,
        req: CompletionRequest,
    ) -> Result<BoxStream<'static, Result<Token, CoreError>>, CoreError> {
        let mut source = self.send(req, true).await?.bytes_stream();
        Ok(Box::pin(async_stream::try_stream! {
            let mut lines = SseLines::default();
            let mut data = Vec::new();
            while let Some(chunk) = source.next().await {
                for bytes in lines.push(&chunk?) {
                    let line = std::str::from_utf8(&bytes).map_err(|e| CoreError::Protocol(e.to_string()))?;
                    if line.is_empty() {
                        if data.is_empty() { continue; }
                        let event = data.join("\n");
                        data.clear();
                        if event == "[DONE]" { return; }
                        for token in parse_event(&event)? { yield token; }
                    } else if let Some(value) = line.strip_prefix("data:") {
                        data.push(value.strip_prefix(' ').unwrap_or(value).to_owned());
                    }
                }
            }
            Err(CoreError::IncompleteStream)?;
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sse_line_endings_across_chunks() {
        for ending in ["\r", "\n", "\r\n"] {
            let input = format!("first{ending}second{ending}{ending}");
            for split in 0..=input.len() {
                let mut lines = SseLines::default();
                let (first, second) = input.as_bytes().split_at(split);
                let mut actual = lines.push(first);
                actual.extend(lines.push(second));
                assert_eq!(
                    actual,
                    vec![b"first".to_vec(), b"second".to_vec(), Vec::new()]
                );
                assert!(lines.pending.is_empty());
            }
        }
        let mut lines = SseLines::default();
        assert!(lines.push(b"partial").is_empty());
        assert_eq!(lines.push(b"\r"), vec![b"partial".to_vec()]);
        assert!(lines.push(b"\n").is_empty());
        assert_eq!(lines.push(b"\r"), vec![Vec::<u8>::new()]);
    }

    #[test]
    fn tool_wire_arguments_and_definition_round_trip() {
        let call = ToolCall {
            id: "c".into(),
            name: "f".into(),
            arguments: json!({"n": 1}),
            extra_content: None,
        };
        let wire = serde_json::to_value(&call).unwrap();
        assert_eq!(wire.pointer("/function/arguments").unwrap(), r#"{"n":1}"#);
        assert_eq!(serde_json::from_value::<ToolCall>(wire).unwrap(), call);
        let definition = ToolDefinition {
            name: "f".into(),
            description: "function".into(),
            parameters: json!({"type":"object"}),
        };
        let wire = serde_json::to_value(&definition).unwrap();
        assert_eq!(wire.get("type").unwrap(), "function");
        assert_eq!(
            serde_json::from_value::<ToolDefinition>(wire).unwrap(),
            definition
        );
        for value in [
            json!({"type":"other","function":{"name":"f","description":"","parameters":{}}}),
            json!({"type":"function","function":{}}),
        ] {
            assert!(serde_json::from_value::<ToolDefinition>(value).is_err());
        }
        assert!(
            serde_json::from_value::<ToolCall>(
                json!({"id":"c","type":"other","function":{"name":"f","arguments":"{}"}})
            )
            .is_err()
        );
    }

    #[test]
    fn extra_content_round_trips_on_wire_and_stream() {
        // Gemini requires thought_signature echoed back verbatim on the next turn.
        let signature = json!({"google": {"thought_signature": "sig"}});
        let call: ToolCall = serde_json::from_value(
            json!({"id":"c","type":"function","function":{"name":"f","arguments":"{}"},
                   "extra_content": signature}),
        )
        .unwrap();
        let wire = serde_json::to_value(&call).unwrap();
        assert_eq!(
            wire.pointer("/extra_content/google/thought_signature"),
            Some(&json!("sig"))
        );
        let message = Message {
            role: Role::Assistant,
            content: None,
            tool_calls: vec![call],
            tool_call_id: None,
            extra_content: Some(signature.clone()),
        };
        let wire = serde_json::to_value(&message).unwrap();
        assert_eq!(
            wire.pointer("/tool_calls/0/extra_content/google/thought_signature"),
            Some(&json!("sig"))
        );
        assert_eq!(
            wire.pointer("/extra_content/google/thought_signature"),
            Some(&json!("sig"))
        );
        assert_eq!(serde_json::from_value::<Message>(wire).unwrap(), message);
        let event = json!({
            "choices": [{
                "delta": {
                    "extra_content": {"google": {"thought_signature": "s"}},
                    "tool_calls": [{"index": 0, "id": "c",
                        "extra_content": {"google": {"thought_signature": "t"}}}],
                }
            }]
        });
        let tokens = parse_event(&event.to_string()).unwrap();
        assert_eq!(
            tokens,
            vec![
                Token::ToolCall {
                    index: 0,
                    id: Some("c".into()),
                    name: None,
                    arguments: None,
                    extra_content: Some(json!({"google":{"thought_signature":"t"}})),
                },
                Token::ExtraContent(json!({"google":{"thought_signature":"s"}})),
            ]
        );
    }

    #[test]
    fn stream_event_empty_text_errors_and_finish() {
        assert!(parse_event(r#"{"choices":[]}"#).unwrap().is_empty());
        assert!(parse_event("bad JSON").is_err());
        assert!(
            parse_event(r#"{"choices":[{"delta":{"tool_calls":[{"index":"bad"}]}}]}"#).is_err()
        );
        let tokens = parse_event(r#"{"choices":[{"delta":{"content":"","tool_calls":[{"index":0,"id":"c"}]},"finish_reason":"stop"}]}"#).unwrap();
        assert_eq!(
            tokens,
            vec![
                Token::Text(String::new()),
                Token::ToolCall {
                    index: 0,
                    id: Some("c".into()),
                    name: None,
                    arguments: None,
                    extra_content: None,
                },
                Token::Finished("stop".into())
            ]
        );
    }
}
