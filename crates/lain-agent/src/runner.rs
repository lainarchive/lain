use std::{
    collections::HashSet,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Instant, SystemTime, UNIX_EPOCH},
};

use lain_core::{
    provider::{CompletionRequest, Message, ModelProvider, Role, ToolCall},
    tools::ToolRegistry,
};
use lain_memory::{MemoryInput, MemoryRecord, MemoryStore, SearchOptions, StoreError};
use serde_json::json;
use tokio::sync::broadcast;

use crate::{
    AgentConfig, AgentError, AgentEvent, AgentState, AgentStatus, BudgetKind, TerminationReason,
    ToolOutcome,
};

/// A receiver more than this many events behind gets `RecvError::Lagged`; the runner never waits on a slow UI.
pub const EVENT_CAPACITY: usize = 1024;
const QUERY_MAX_UTF16: usize = 1000;
const CONTENT_MAX_UTF16: usize = 999_000;
const RECALL_TERMS: usize = 8;
const WITHHELD: &str = "[withheld: the memory store refused a residual secret shape]";

#[derive(Debug, Clone, PartialEq)]
pub struct RunOutcome {
    pub status: AgentStatus,
    pub output: Option<String>,
    pub turns: u32,
}

pub struct AgentRunner {
    config: AgentConfig,
    provider: Arc<dyn ModelProvider>,
    tools: Arc<ToolRegistry>,
    memory: Arc<Mutex<MemoryStore>>,
    state: AgentState,
    events: broadcast::Sender<AgentEvent>,
    started: Option<Instant>,
}

impl std::fmt::Debug for AgentRunner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AgentRunner")
            .field("session_id", &self.state.session_id)
            .field("status", &self.state.status)
            .field("turn_count", &self.state.turn_count)
            .finish_non_exhaustive()
    }
}

pub fn new_session_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    format!(
        "agent-{nanos:x}-{}",
        COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

impl AgentRunner {
    pub fn new(
        config: AgentConfig,
        provider: Arc<dyn ModelProvider>,
        tools: Arc<ToolRegistry>,
        memory: Arc<Mutex<MemoryStore>>,
        session_id: impl Into<String>,
    ) -> Result<Self, AgentError> {
        config.validate()?;
        let session_id = session_id.into();
        // Session ids become memory ids, which the store caps at 200 UTF-16 units; 120 leaves room for the turn suffix.
        if session_id.is_empty()
            || session_id.len() > 120
            || !session_id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        {
            return Err(AgentError::Config(
                "session_id must be 1..=120 of [A-Za-z0-9._-]".into(),
            ));
        }
        let (events, _) = broadcast::channel(EVENT_CAPACITY);
        Ok(Self {
            config,
            provider,
            tools,
            memory,
            state: AgentState::new(session_id),
            events,
            started: None,
        })
    }

    pub fn from_config(
        config: AgentConfig,
        tools: Arc<ToolRegistry>,
        memory: Arc<Mutex<MemoryStore>>,
        session_id: impl Into<String>,
    ) -> Result<Self, AgentError> {
        let provider = config.provider.build()?;
        Self::new(config, provider, tools, memory, session_id)
    }

    pub fn subscribe(&self) -> broadcast::Receiver<AgentEvent> {
        self.events.subscribe()
    }

    pub fn state(&self) -> &AgentState {
        &self.state
    }

    pub fn config(&self) -> &AgentConfig {
        &self.config
    }

    pub fn terminate(&mut self) {
        if !matches!(self.state.status, AgentStatus::Terminated(_)) {
            self.stop(TerminationReason::Cancelled, 0);
        }
    }

    /// Runs one user input to an answer or a termination. A breaker or budget stop is `Ok` with a terminated status;
    /// a provider or memory failure is `Err`, and terminates too.
    pub async fn run(&mut self, input: impl Into<String>) -> Result<RunOutcome, AgentError> {
        if let AgentStatus::Terminated(reason) = &self.state.status {
            return Err(AgentError::Terminated(reason.clone()));
        }
        let input = input.into();
        if input.trim().is_empty() {
            return Err(AgentError::EmptyInput);
        }
        self.started.get_or_insert_with(Instant::now);
        self.state.status = AgentStatus::Running;
        match self.react(input).await {
            Ok(outcome) => Ok(outcome),
            // Fail-closed, not retried: a turn whose transcript did not reach memory, or whose model call died
            // mid-plan, leaves no state I would trust to resume from.
            Err(error) => {
                let reason = match &error {
                    AgentError::Provider(_) => TerminationReason::ProviderFailed,
                    _ => TerminationReason::MemoryFailed,
                };
                self.stop(reason, 0);
                Err(error)
            }
        }
    }

    async fn react(&mut self, input: String) -> Result<RunOutcome, AgentError> {
        if self.state.messages.is_empty() && !self.config.system_prompt.trim().is_empty() {
            self.state.messages.push(Message::text(
                Role::System,
                self.config.system_prompt.clone(),
            ));
        }
        let recalled = self.recall(&input).await?;
        if !recalled.is_empty() {
            let mut context = String::from("Recalled memory (trusted, most relevant first):");
            for record in &recalled {
                context.push_str(&format!(
                    "\n- {} [{}]: {}",
                    record.title, record.id, record.content
                ));
            }
            self.state
                .messages
                .push(Message::text(Role::System, context));
        }
        self.state.inputs += 1;
        let input_id = format!("{}/input/{}", self.state.session_id, self.state.inputs);
        self.commit(&input_id, "user input".into(), input.clone(), None)
            .await?;
        self.state.messages.push(Message::text(Role::User, input));

        for run_turn in 1..=self.config.max_turns {
            if let Some(budget) = self.spent_budget() {
                return Ok(self.stop(TerminationReason::BudgetExhausted { budget }, run_turn - 1));
            }
            self.state.turn_count += 1;
            let turn = self.state.turn_count;
            self.emit(AgentEvent::TurnStarted {
                session_id: self.state.session_id.clone(),
                turn,
            });
            let response = self
                .provider
                .complete(CompletionRequest {
                    model: self.config.model.clone(),
                    messages: self.state.messages.clone(),
                    tools: self.tools.definitions(),
                    temperature: self.config.temperature,
                    max_tokens: self.config.budget.max_completion_tokens,
                })
                .await?;
            if let Some(usage) = &response.usage {
                self.state.tokens_used = self.state.tokens_used.saturating_add(usage.total_tokens);
            }
            let message = response.message;
            let turn_id = format!("{}/turn/{turn}", self.state.session_id);
            self.commit(
                &turn_id,
                format!("turn {turn}"),
                json!(message).to_string(),
                Some((input_id.clone(), "responds_to")),
            )
            .await?;
            self.state.messages.push(message.clone());

            if message.tool_calls.is_empty() {
                let text = message.content.unwrap_or_default();
                self.emit(AgentEvent::OutputGenerated {
                    turn,
                    text: text.clone(),
                });
                self.emit(AgentEvent::TurnCompleted {
                    turn,
                    tool_calls: 0,
                    tokens_used: self.state.tokens_used,
                });
                self.state.status = AgentStatus::AwaitingInput;
                return Ok(RunOutcome {
                    status: self.state.status.clone(),
                    output: Some(text),
                    turns: run_turn,
                });
            }
            if let Some(text) = message.content.filter(|t| !t.trim().is_empty()) {
                self.emit(AgentEvent::Thinking { turn, text });
            }
            let halt = self.act(turn, &turn_id, &message.tool_calls).await?;
            self.emit(AgentEvent::TurnCompleted {
                turn,
                tool_calls: message.tool_calls.len(),
                tokens_used: self.state.tokens_used,
            });
            if let Some(reason) = halt {
                return Ok(self.stop(reason, run_turn));
            }
        }
        Ok(self.stop(TerminationReason::MaxTurns, self.config.max_turns))
    }

    /// Every call gets a tool message, skipped ones included: an assistant message whose calls are not all answered
    /// is a request OpenAI-compatible servers reject, which would make the transcript unusable for a resume.
    async fn act(
        &mut self,
        turn: u32,
        turn_id: &str,
        calls: &[ToolCall],
    ) -> Result<Option<TerminationReason>, AgentError> {
        let mut halt: Option<TerminationReason> = None;
        for (index, call) in calls.iter().enumerate() {
            let outcome = if let Some(reason) = &halt {
                skipped(reason)
            } else if self
                .config
                .budget
                .max_tool_calls
                .is_some_and(|max| self.state.tool_calls >= max)
            {
                let reason = TerminationReason::BudgetExhausted {
                    budget: BudgetKind::ToolCalls,
                };
                let outcome = skipped(&reason);
                halt = Some(reason);
                outcome
            } else {
                self.emit(AgentEvent::ToolInvoked {
                    turn,
                    call_id: call.id.clone(),
                    name: call.name.clone(),
                    arguments: call.arguments.clone(),
                });
                self.state.tool_calls += 1;
                let outcome = match self
                    .tools
                    .dispatch(&call.name, call.arguments.clone())
                    .await
                {
                    Ok(output) => ToolOutcome::Succeeded(output),
                    Err(error) => ToolOutcome::Failed {
                        code: error.code().into(),
                        message: error.to_string(),
                    },
                };
                if outcome.is_error() {
                    self.state.consecutive_tool_errors += 1;
                } else {
                    self.state.consecutive_tool_errors = 0;
                }
                if self.state.consecutive_tool_errors >= self.config.max_consecutive_tool_errors {
                    halt = Some(TerminationReason::ToolErrorLimit);
                }
                outcome
            };
            let content = match &outcome {
                ToolOutcome::Succeeded(output) => json!(output),
                ToolOutcome::Failed { code, message } => json!({"error": message, "code": code}),
                ToolOutcome::Skipped { reason } => json!({"skipped": reason}),
            }
            .to_string();
            self.commit(
                &format!("{turn_id}/tool/{index}"),
                format!("turn {turn} tool {}", call.name),
                json!({"call_id": call.id, "name": call.name, "arguments": call.arguments, "outcome": outcome})
                    .to_string(),
                Some((turn_id.to_owned(), "result_of")),
            )
            .await?;
            self.emit(AgentEvent::ToolCompleted {
                turn,
                call_id: call.id.clone(),
                name: call.name.clone(),
                outcome,
            });
            self.state.messages.push(Message {
                role: Role::Tool,
                content: Some(content),
                tool_calls: Vec::new(),
                tool_call_id: Some(call.id.clone()),
            });
        }
        Ok(halt)
    }

    fn spent_budget(&self) -> Option<BudgetKind> {
        let budget = &self.config.budget;
        if budget
            .max_total_tokens
            .is_some_and(|max| self.state.tokens_used >= max)
        {
            return Some(BudgetKind::TotalTokens);
        }
        let elapsed = self.started.map_or(0, |s| s.elapsed().as_millis());
        if budget
            .max_wall_time_ms
            .is_some_and(|max| elapsed >= u128::from(max))
        {
            return Some(BudgetKind::WallTime);
        }
        None
    }

    fn stop(&mut self, reason: TerminationReason, turns: u32) -> RunOutcome {
        self.state.status = AgentStatus::Terminated(reason.clone());
        self.emit(AgentEvent::Terminated {
            turn: self.state.turn_count,
            reason,
        });
        RunOutcome {
            status: self.state.status.clone(),
            output: None,
            turns,
        }
    }

    fn emit(&self, event: AgentEvent) {
        // No subscriber is a normal state, not an error.
        let _ = self.events.send(event);
    }

    /// The store's FTS joins every term with AND, so a whole sentence rarely matches. When it misses, I fall back to
    /// one search per distinct long word and merge in first-hit order.
    async fn recall(&self, input: &str) -> Result<Vec<MemoryRecord>, AgentError> {
        let limit = self.config.memory_context_limit;
        if limit == 0 {
            return Ok(Vec::new());
        }
        let query = clip_utf16(input, QUERY_MAX_UTF16);
        with_store(self.memory.clone(), move |store| {
            let options = SearchOptions {
                limit,
                include_untrusted: false,
            };
            let records = store.search(&query, options.clone())?;
            if !records.is_empty() {
                return Ok(records);
            }
            let mut seen_terms = HashSet::new();
            let mut seen_ids = HashSet::new();
            let mut merged = Vec::new();
            let terms = query
                .split(|c: char| !c.is_alphanumeric())
                .filter(|t| t.chars().count() >= 4)
                .map(str::to_lowercase)
                .filter(|t| seen_terms.insert(t.clone()))
                .take(RECALL_TERMS)
                .collect::<Vec<_>>();
            for term in terms {
                for record in store.search(&term, options.clone())? {
                    if seen_ids.insert(record.id.clone()) {
                        merged.push(record);
                    }
                }
            }
            merged.truncate(usize::try_from(limit).unwrap_or(0));
            Ok(merged)
        })
        .await
    }

    /// Transcript records are written untrusted on purpose: model and tool text must never come back through a
    /// trusted-only search, `MemoryReadTool`'s included, as if a person had approved it.
    async fn commit(
        &self,
        id: &str,
        title: String,
        content: String,
        link: Option<(String, &'static str)>,
    ) -> Result<(), AgentError> {
        let id = id.to_owned();
        let source = format!("lain-agent:{}", self.state.session_id);
        let content = if content.encode_utf16().count() > CONTENT_MAX_UTF16 {
            format!("{}\n[truncated]", clip_utf16(&content, CONTENT_MAX_UTF16))
        } else {
            content
        };
        with_store(self.memory.clone(), move |store| {
            let record = |content: String| MemoryInput {
                id: Some(id.clone()),
                title: title.clone(),
                content,
                kind: Some("fact".into()),
                trust: Some("untrusted".into()),
                source: source.clone(),
            };
            match store.remember(record(content)) {
                Err(StoreError::SecretRefused) => store.remember(record(WITHHELD.into()))?,
                other => other?,
            };
            if let Some((to, relation)) = link {
                store.link(&id, &to, relation, &source, Some("untrusted"))?;
            }
            Ok(())
        })
        .await
    }
}

fn skipped(reason: &TerminationReason) -> ToolOutcome {
    ToolOutcome::Skipped {
        reason: format!("not run: agent stopping ({reason:?})"),
    }
}

fn clip_utf16(text: &str, max: usize) -> String {
    let mut units = 0;
    text.chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= max
        })
        .collect()
}

/// SQLite work runs on a blocking worker so the std mutex never spans an await.
async fn with_store<T: Send + 'static>(
    store: Arc<Mutex<MemoryStore>>,
    work: impl FnOnce(&mut MemoryStore) -> Result<T, StoreError> + Send + 'static,
) -> Result<T, AgentError> {
    tokio::task::spawn_blocking(move || {
        let mut guard = store
            .lock()
            .map_err(|e| AgentError::Worker(e.to_string()))?;
        work(&mut guard).map_err(AgentError::from)
    })
    .await
    .map_err(|e| AgentError::Worker(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use async_trait::async_trait;
    use futures::stream::BoxStream;
    use lain_core::{
        provider::{CompletionResponse, Token, Usage},
        tools::{Tool, ToolError, ToolOutput},
        CoreError,
    };
    use serde_json::{json, Value};

    use super::*;
    use crate::{BudgetLimits, ProviderSelection};

    #[derive(Debug, Default)]
    struct ScriptedProvider {
        script: Mutex<VecDeque<Result<CompletionResponse, CoreError>>>,
        requests: Mutex<Vec<CompletionRequest>>,
    }

    impl ScriptedProvider {
        fn new(script: Vec<Result<CompletionResponse, CoreError>>) -> Arc<Self> {
            Arc::new(Self {
                script: Mutex::new(script.into()),
                requests: Mutex::default(),
            })
        }
        fn requests(&self) -> Vec<CompletionRequest> {
            self.requests.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl ModelProvider for ScriptedProvider {
        async fn complete(&self, req: CompletionRequest) -> Result<CompletionResponse, CoreError> {
            self.requests.lock().unwrap().push(req);
            self.script
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| Err(CoreError::Protocol("script exhausted".into())))
        }
        async fn stream(
            &self,
            _: CompletionRequest,
        ) -> Result<BoxStream<'static, Result<Token, CoreError>>, CoreError> {
            Err(CoreError::Protocol(
                "scripted provider only completes".into(),
            ))
        }
    }

    #[derive(Debug)]
    struct StubTool {
        name: &'static str,
        result: Result<Option<i32>, &'static str>,
    }

    #[async_trait]
    impl Tool for StubTool {
        fn name(&self) -> &str {
            self.name
        }
        fn description(&self) -> &str {
            "stub"
        }
        fn parameters_schema(&self) -> Value {
            json!({"type":"object","properties":{"n":{"type":"integer"}},"additionalProperties":false})
        }
        async fn execute(&self, args: Value) -> Result<ToolOutput, ToolError> {
            match self.result {
                Ok(exit_code) => Ok(ToolOutput {
                    content: format!("{} {args}", self.name),
                    exit_code,
                }),
                Err(message) => Err(ToolError::Execution(message.into())),
            }
        }
    }

    fn text(content: &str) -> Result<CompletionResponse, CoreError> {
        Ok(CompletionResponse {
            message: Message::text(Role::Assistant, content),
            finish_reason: Some("stop".into()),
            usage: Some(Usage {
                prompt_tokens: 7,
                completion_tokens: 3,
                total_tokens: 10,
            }),
        })
    }

    fn calls(thought: Option<&str>, names: &[&str]) -> Result<CompletionResponse, CoreError> {
        let mut message = Message::text(Role::Assistant, thought.unwrap_or_default());
        message.content = thought.map(Into::into);
        message.tool_calls = names
            .iter()
            .enumerate()
            .map(|(i, name)| ToolCall {
                id: format!("call-{i}"),
                name: (*name).into(),
                arguments: json!({"n": i}),
            })
            .collect();
        Ok(CompletionResponse {
            message,
            finish_reason: Some("tool_calls".into()),
            usage: Some(Usage {
                prompt_tokens: 70,
                completion_tokens: 30,
                total_tokens: 100,
            }),
        })
    }

    fn config() -> AgentConfig {
        let mut config = AgentConfig::new(
            ProviderSelection::OpenAiCompatible {
                base_url: "http://127.0.0.1:9/v1".into(),
                api_key_env: None,
            },
            "mock",
        );
        config.system_prompt = "You are Lain.".into();
        config
    }

    fn registry() -> Arc<ToolRegistry> {
        let mut registry = ToolRegistry::new();
        for tool in [
            StubTool {
                name: "ok",
                result: Ok(None),
            },
            StubTool {
                name: "fail",
                result: Err("boom"),
            },
            StubTool {
                name: "exit2",
                result: Ok(Some(2)),
            },
        ] {
            registry.register(Arc::new(tool)).unwrap();
        }
        Arc::new(registry)
    }

    fn memory() -> Arc<Mutex<MemoryStore>> {
        Arc::new(Mutex::new(MemoryStore::open(":memory:").unwrap()))
    }

    fn runner(
        config: AgentConfig,
        provider: Arc<ScriptedProvider>,
    ) -> (AgentRunner, Arc<Mutex<MemoryStore>>) {
        let store = memory();
        let runner = AgentRunner::new(config, provider, registry(), store.clone(), "s1").unwrap();
        (runner, store)
    }

    fn drain(rx: &mut broadcast::Receiver<AgentEvent>) -> Vec<AgentEvent> {
        std::iter::from_fn(|| rx.try_recv().ok()).collect()
    }

    fn kinds(events: &[AgentEvent]) -> Vec<&'static str> {
        events
            .iter()
            .map(|e| match e {
                AgentEvent::TurnStarted { .. } => "turn_started",
                AgentEvent::Thinking { .. } => "thinking",
                AgentEvent::ToolInvoked { .. } => "tool_invoked",
                AgentEvent::ToolCompleted { .. } => "tool_completed",
                AgentEvent::OutputGenerated { .. } => "output",
                AgentEvent::TurnCompleted { .. } => "turn_completed",
                AgentEvent::Terminated { .. } => "terminated",
            })
            .collect()
    }

    fn outcomes(events: &[AgentEvent]) -> Vec<ToolOutcome> {
        events
            .iter()
            .filter_map(|e| match e {
                AgentEvent::ToolCompleted { outcome, .. } => Some(outcome.clone()),
                _ => None,
            })
            .collect()
    }

    #[tokio::test]
    async fn final_text_answers_and_awaits_input() {
        let provider = ScriptedProvider::new(vec![text("hello")]);
        let (mut agent, store) = runner(config(), provider.clone());
        let mut rx = agent.subscribe();
        assert_eq!(agent.state().status, AgentStatus::Idle);
        let outcome = agent.run("say hello").await.unwrap();
        assert_eq!(outcome.output.as_deref(), Some("hello"));
        assert_eq!(outcome.status, AgentStatus::AwaitingInput);
        assert_eq!(outcome.turns, 1);
        assert_eq!(
            kinds(&drain(&mut rx)),
            ["turn_started", "output", "turn_completed"]
        );
        let state = agent.state();
        assert_eq!(
            (state.turn_count, state.tokens_used, state.messages.len()),
            (1, 10, 3)
        );
        let request = provider.requests().remove(0);
        assert_eq!(request.model, "mock");
        assert_eq!(request.tools, registry().definitions());
        assert_eq!(
            request.messages.first().unwrap().content.as_deref(),
            Some("You are Lain.")
        );
        let store = store.lock().unwrap();
        let input = store.get("s1/input/1").unwrap().unwrap();
        assert_eq!(
            (input.content.as_str(), input.trust.as_str()),
            ("say hello", "untrusted")
        );
        let turn = store.get("s1/turn/1").unwrap().unwrap();
        assert!(turn.content.contains("hello"));
        assert_eq!(
            store.provenance("s1/turn/1").unwrap().unwrap().source,
            "lain-agent:s1"
        );
    }

    #[tokio::test]
    async fn tool_turn_events_messages_and_records() {
        let provider =
            ScriptedProvider::new(vec![calls(Some("check first"), &["ok"]), text("done")]);
        let (mut agent, store) = runner(config(), provider.clone());
        let mut rx = agent.subscribe();
        let outcome = agent.run("go").await.unwrap();
        assert_eq!(outcome.output.as_deref(), Some("done"));
        assert_eq!(outcome.turns, 2);
        let events = drain(&mut rx);
        assert_eq!(
            kinds(&events),
            [
                "turn_started",
                "thinking",
                "tool_invoked",
                "tool_completed",
                "turn_completed",
                "turn_started",
                "output",
                "turn_completed"
            ]
        );
        assert!(events.contains(&AgentEvent::Thinking {
            turn: 1,
            text: "check first".into()
        }));
        let second = provider.requests().pop().unwrap();
        let tool = second.messages.last().unwrap();
        assert_eq!(
            (tool.role.clone(), tool.tool_call_id.as_deref()),
            (Role::Tool, Some("call-0"))
        );
        assert!(tool.content.as_deref().unwrap().contains(r#"ok {\"n\":0}"#));
        let store = store.lock().unwrap();
        let record = store.get("s1/turn/1/tool/0").unwrap().unwrap();
        assert!(record.content.contains(r#""name":"ok""#));
        assert!(record.content.contains("succeeded"));
        let neighbors = store
            .neighbors(
                "s1/turn/1/tool/0",
                lain_memory::NeighborOptions {
                    depth: 2,
                    include_untrusted: true,
                },
            )
            .unwrap();
        let ids: Vec<_> = neighbors.nodes.iter().map(|n| n.id.as_str()).collect();
        assert!(
            ids.contains(&"s1/turn/1") && ids.contains(&"s1/input/1"),
            "{ids:?}"
        );
    }

    #[tokio::test]
    async fn breaker_trips_after_three_consecutive_errors() {
        let script = (0..5).map(|_| calls(None, &["fail"])).collect();
        let provider = ScriptedProvider::new(script);
        let (mut agent, _) = runner(config(), provider.clone());
        let mut rx = agent.subscribe();
        let outcome = agent.run("loop").await.unwrap();
        assert_eq!(
            outcome.status,
            AgentStatus::Terminated(TerminationReason::ToolErrorLimit)
        );
        assert_eq!((outcome.turns, outcome.output), (3, None));
        assert_eq!(provider.requests().len(), 3);
        let events = drain(&mut rx);
        assert_eq!(kinds(&events).last(), Some(&"terminated"));
        assert!(matches!(
            outcomes(&events).first(),
            Some(ToolOutcome::Failed { code, .. }) if code == "TOOL_EXECUTION_FAILED"
        ));
        assert!(matches!(
            agent.run("again").await,
            Err(AgentError::Terminated(TerminationReason::ToolErrorLimit))
        ));
    }

    #[tokio::test]
    async fn success_resets_breaker() {
        let provider = ScriptedProvider::new(vec![
            calls(None, &["fail", "fail"]),
            calls(None, &["ok"]),
            calls(None, &["fail", "exit2"]),
            text("recovered"),
        ]);
        let (mut agent, _) = runner(config(), provider);
        let outcome = agent.run("flaky").await.unwrap();
        assert_eq!(outcome.output.as_deref(), Some("recovered"));
        assert_eq!(agent.state().consecutive_tool_errors, 2);
        assert_eq!(agent.state().tool_calls, 5);
    }

    #[tokio::test]
    async fn breaker_mid_turn_answers_remaining_calls_as_skipped() {
        let provider =
            ScriptedProvider::new(vec![calls(None, &["fail", "missing", "exit2", "ok"])]);
        let (mut agent, _) = runner(config(), provider);
        let mut rx = agent.subscribe();
        let outcome = agent.run("burst").await.unwrap();
        assert_eq!(
            outcome.status,
            AgentStatus::Terminated(TerminationReason::ToolErrorLimit)
        );
        let events = drain(&mut rx);
        let outcomes = outcomes(&events);
        assert!(
            matches!(outcomes.get(1), Some(ToolOutcome::Failed { code, .. }) if code == "TOOL_NOT_FOUND")
        );
        assert!(
            matches!(outcomes.get(2), Some(ToolOutcome::Succeeded(o)) if o.exit_code == Some(2))
        );
        assert!(matches!(outcomes.get(3), Some(ToolOutcome::Skipped { .. })));
        assert_eq!(
            kinds(&events)
                .iter()
                .filter(|k| **k == "tool_invoked")
                .count(),
            3
        );
        let tool_messages = agent
            .state()
            .messages
            .iter()
            .filter(|m| m.role == Role::Tool)
            .count();
        assert_eq!(tool_messages, 4);
        assert_eq!(agent.state().tool_calls, 3);
    }

    #[tokio::test]
    async fn invalid_arguments_are_tool_errors() {
        let mut response = calls(None, &["ok"]).unwrap();
        response
            .message
            .tool_calls
            .iter_mut()
            .for_each(|c| c.arguments = json!({"n": "x"}));
        let provider = ScriptedProvider::new(vec![Ok(response), text("fine")]);
        let (mut agent, _) = runner(config(), provider);
        let mut rx = agent.subscribe();
        agent.run("args").await.unwrap();
        assert!(matches!(
            outcomes(&drain(&mut rx)).first(),
            Some(ToolOutcome::Failed { code, .. }) if code == "TOOL_ARGUMENTS_INVALID"
        ));
    }

    #[tokio::test]
    async fn turn_limit_terminates_runaway() {
        let mut config = config();
        config.max_turns = 2;
        let provider = ScriptedProvider::new((0..5).map(|_| calls(None, &["ok"])).collect());
        let (mut agent, _) = runner(config, provider.clone());
        let outcome = agent.run("forever").await.unwrap();
        assert_eq!(
            outcome.status,
            AgentStatus::Terminated(TerminationReason::MaxTurns)
        );
        assert_eq!((outcome.turns, provider.requests().len()), (2, 2));
    }

    #[tokio::test]
    async fn token_budget_stops_before_next_turn() {
        let mut config = config();
        config.budget = BudgetLimits {
            max_total_tokens: Some(150),
            max_completion_tokens: Some(64),
            ..BudgetLimits::default()
        };
        let provider = ScriptedProvider::new((0..5).map(|_| calls(None, &["ok"])).collect());
        let (mut agent, _) = runner(config, provider.clone());
        let outcome = agent.run("spend").await.unwrap();
        let budget = BudgetKind::TotalTokens;
        assert_eq!(
            outcome.status,
            AgentStatus::Terminated(TerminationReason::BudgetExhausted { budget })
        );
        assert_eq!((outcome.turns, agent.state().tokens_used), (2, 200));
        assert!(provider.requests().iter().all(|r| r.max_tokens == Some(64)));
    }

    #[tokio::test]
    async fn tool_call_budget_skips_the_excess() {
        let mut config = config();
        config.budget.max_tool_calls = Some(1);
        let provider = ScriptedProvider::new(vec![calls(None, &["ok", "ok"])]);
        let (mut agent, _) = runner(config, provider);
        let mut rx = agent.subscribe();
        let outcome = agent.run("two").await.unwrap();
        let budget = BudgetKind::ToolCalls;
        assert_eq!(
            outcome.status,
            AgentStatus::Terminated(TerminationReason::BudgetExhausted { budget })
        );
        let outcomes = outcomes(&drain(&mut rx));
        assert!(matches!(
            outcomes.as_slice(),
            [ToolOutcome::Succeeded(_), ToolOutcome::Skipped { .. }]
        ));
    }

    #[tokio::test]
    async fn wall_time_budget_stops_before_first_turn() {
        let mut config = config();
        config.budget.max_wall_time_ms = Some(0);
        let provider = ScriptedProvider::new(vec![text("never")]);
        let (mut agent, _) = runner(config, provider.clone());
        let outcome = agent.run("late").await.unwrap();
        let budget = BudgetKind::WallTime;
        assert_eq!(
            outcome.status,
            AgentStatus::Terminated(TerminationReason::BudgetExhausted { budget })
        );
        assert!(provider.requests().is_empty());
    }

    #[tokio::test]
    async fn provider_failure_terminates_with_error() {
        let provider = ScriptedProvider::new(vec![Err(CoreError::Protocol("bad".into()))]);
        let (mut agent, _) = runner(config(), provider);
        let mut rx = agent.subscribe();
        let error = agent.run("x").await.unwrap_err();
        assert_eq!(error.code(), "AGENT_PROVIDER_FAILED");
        assert_eq!(
            agent.state().status,
            AgentStatus::Terminated(TerminationReason::ProviderFailed)
        );
        assert_eq!(kinds(&drain(&mut rx)), ["turn_started", "terminated"]);
    }

    #[tokio::test]
    async fn recall_injects_trusted_memory_only() {
        let provider = ScriptedProvider::new(vec![text("ok")]);
        let (mut agent, store) = runner(config(), provider.clone());
        {
            let mut store = store.lock().unwrap();
            for (title, trust) in [("deploy trusted", "trusted"), ("deploy rumor", "untrusted")] {
                store
                    .remember(MemoryInput {
                        title: title.into(),
                        content: format!("{title} deployment window is Friday"),
                        trust: Some(trust.into()),
                        source: "test".into(),
                        ..MemoryInput::default()
                    })
                    .unwrap();
            }
        }
        agent.run("When is the deployment window?").await.unwrap();
        let request = provider.requests().remove(0);
        let recalled = request.messages.get(1).unwrap().content.clone().unwrap();
        assert!(
            recalled.contains("deploy trusted deployment window"),
            "{recalled}"
        );
        assert!(!recalled.contains("rumor"));
        assert_eq!(request.messages.last().unwrap().role, Role::User);
    }

    #[tokio::test]
    async fn conversation_continues_across_inputs() {
        let mut config = config();
        config.memory_context_limit = 0;
        let provider = ScriptedProvider::new(vec![text("one"), text("two")]);
        let (mut agent, store) = runner(config, provider.clone());
        agent.run("first").await.unwrap();
        let outcome = agent.run("second").await.unwrap();
        assert_eq!(outcome.output.as_deref(), Some("two"));
        assert_eq!(agent.state().turn_count, 2);
        assert_eq!(provider.requests().pop().unwrap().messages.len(), 4);
        assert!(store.lock().unwrap().get("s1/input/2").unwrap().is_some());
    }

    #[tokio::test]
    async fn cancel_and_input_validation() {
        let (mut agent, _) = runner(config(), ScriptedProvider::new(vec![]));
        assert!(matches!(agent.run("  ").await, Err(AgentError::EmptyInput)));
        assert_eq!(agent.state().status, AgentStatus::Idle);
        agent.terminate();
        assert!(matches!(
            agent.run("x").await,
            Err(AgentError::Terminated(TerminationReason::Cancelled))
        ));
    }

    #[test]
    fn config_and_session_validation() {
        let provider: Arc<dyn ModelProvider> = ScriptedProvider::new(vec![]);
        let build = |config: AgentConfig, id: &str| {
            AgentRunner::new(config, provider.clone(), registry(), memory(), id).map(|_| ())
        };
        assert!(build(config(), "ok-session_1.2").is_ok());
        for id in ["", "has space", "slash/es", &"x".repeat(121)] {
            assert!(
                matches!(build(config(), id), Err(AgentError::Config(_))),
                "{id:?}"
            );
        }
        let broken: [fn(&mut AgentConfig); 5] = [
            |c| c.model = " ".into(),
            |c| c.max_turns = 0,
            |c| c.max_consecutive_tool_errors = 0,
            |c| c.memory_context_limit = 101,
            |c| c.temperature = Some(2.5),
        ];
        for mutate in broken {
            let mut config = config();
            mutate(&mut config);
            assert_eq!(
                build(config, "s").unwrap_err().code(),
                "AGENT_CONFIG_INVALID"
            );
        }
        let missing = ProviderSelection::OpenAiCompatible {
            base_url: "http://127.0.0.1:9/v1".into(),
            api_key_env: Some("LAIN_AGENT_TEST_KEY_THAT_IS_NEVER_SET".into()),
        };
        assert!(matches!(missing.build(), Err(AgentError::Config(_))));
        assert!(config().provider.build().is_ok());
    }

    #[test]
    fn serde_shapes_for_ui_and_config_files() {
        let event = AgentEvent::ToolCompleted {
            turn: 1,
            call_id: "c".into(),
            name: "bash".into(),
            outcome: ToolOutcome::Skipped { reason: "r".into() },
        };
        assert_eq!(
            serde_json::to_value(&event).unwrap(),
            json!({"type":"tool_completed","turn":1,"call_id":"c","name":"bash","outcome":{"outcome":"skipped","reason":"r"}})
        );
        let status = AgentStatus::Terminated(TerminationReason::BudgetExhausted {
            budget: BudgetKind::WallTime,
        });
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            json!({"status":"terminated","reason":"budget_exhausted","budget":"wall_time"})
        );
        let config = config();
        let text = serde_json::to_string(&config).unwrap();
        assert!(text.contains(r#""kind":"open_ai_compatible""#));
        assert_eq!(serde_json::from_str::<AgentConfig>(&text).unwrap(), config);
    }

    #[test]
    fn ids_and_clipping() {
        assert_ne!(new_session_id(), new_session_id());
        assert_eq!(clip_utf16("a😀b", 2), "a");
        assert_eq!(clip_utf16("a😀b", 3), "a😀");
        assert_eq!(clip_utf16("abc", 10), "abc");
    }
}
