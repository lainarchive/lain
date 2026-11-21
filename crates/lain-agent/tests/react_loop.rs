#[cfg(test)]
mod tests {
    use std::{
        collections::VecDeque,
        sync::{Arc, Mutex},
        time::Duration,
    };

    use async_trait::async_trait;
    use futures::stream::BoxStream;
    use lain_agent::{
        AgentConfig, AgentEvent, AgentRunner, AgentStatus, ProviderSelection, ToolCallMode,
        ToolOutcome, UserFeedback,
    };
    use lain_core::{
        provider::{
            CompletionRequest, CompletionResponse, Message, ModelProvider, Role, Token, ToolCall,
        },
        tools::{BashTool, MemoryReadTool, ToolRegistry},
        CoreError,
    };
    use lain_memory::{MemoryInput, MemoryStore};
    use serde_json::{json, Value};

    type Check = Box<dyn Fn(&CompletionRequest) + Send + Sync>;

    /// Each step checks the request it receives, then returns the next planned reply.
    #[derive(Default)]
    struct PlannedProvider {
        steps: Mutex<VecDeque<(Check, Message)>>,
        calls: Mutex<usize>,
    }

    impl std::fmt::Debug for PlannedProvider {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.debug_struct("PlannedProvider").finish_non_exhaustive()
        }
    }

    #[async_trait]
    impl ModelProvider for PlannedProvider {
        async fn complete(&self, req: CompletionRequest) -> Result<CompletionResponse, CoreError> {
            *self.calls.lock().unwrap() += 1;
            let (check, message) = self
                .steps
                .lock()
                .unwrap()
                .pop_front()
                .ok_or_else(|| CoreError::Protocol("plan exhausted".into()))?;
            check(&req);
            Ok(CompletionResponse {
                message,
                finish_reason: None,
                usage: None,
            })
        }
        async fn stream(
            &self,
            _: CompletionRequest,
        ) -> Result<BoxStream<'static, Result<Token, CoreError>>, CoreError> {
            Err(CoreError::Protocol(
                "planned provider only completes".into(),
            ))
        }
    }

    fn call(id: &str, name: &str, arguments: Value) -> Message {
        let mut message = Message::text(Role::Assistant, format!("next: {name}"));
        message.tool_calls = vec![ToolCall {
            id: id.into(),
            name: name.into(),
            arguments,
        }];
        message
    }

    fn last_tool_output(req: &CompletionRequest, id: &str) -> String {
        let last = req.messages.last().unwrap();
        assert_eq!(last.role, Role::Tool);
        assert_eq!(last.tool_call_id.as_deref(), Some(id));
        last.content.clone().unwrap()
    }

    fn config() -> AgentConfig {
        let mut config = AgentConfig::new(
            ProviderSelection::OpenAiCompatible {
                base_url: "http://127.0.0.1:9/v1".into(),
                api_key_env: None,
            },
            "planned",
        );
        config.system_prompt = "Use tools, then answer.".into();
        config
    }

    #[tokio::test]
    async fn read_memory_then_bash_then_answer() {
        let workspace = tempfile::tempdir().unwrap();
        let store = Arc::new(Mutex::new(MemoryStore::open(":memory:").unwrap()));
        store
            .lock()
            .unwrap()
            .remember(MemoryInput {
                id: Some("fact-codename".into()),
                title: "release codename".into(),
                content: "The release codename is NIGHTJAR.".into(),
                trust: Some("trusted".into()),
                source: "owner".into(),
                ..MemoryInput::default()
            })
            .unwrap();
        let mut registry = ToolRegistry::new();
        registry
            .register(Arc::new(MemoryReadTool::new(store.clone())))
            .unwrap();
        registry
            .register(Arc::new(BashTool {
                working_directory: workspace.path().into(),
                timeout: Duration::from_secs(5),
                output_byte_cap: 4096,
            }))
            .unwrap();

        let steps: Vec<(Check, Message)> = vec![
            (
                Box::new(|req| {
                    let names: Vec<_> = req.tools.iter().map(|t| t.name.as_str()).collect();
                    assert_eq!(names, ["bash", "memory_read", "UpdateScratchpad"]);
                    assert_eq!(req.messages.first().unwrap().role, Role::System);
                }),
                call("c-mem", "memory_read", json!({"query": "codename"})),
            ),
            (
                Box::new(|req| {
                    let output = last_tool_output(req, "c-mem");
                    assert!(output.contains("NIGHTJAR"), "{output}");
                }),
                call(
                    "c-bash",
                    "bash",
                    json!({"command": "echo NIGHTJAR | tr A-Z a-z > name.txt && cat name.txt"}),
                ),
            ),
            (
                Box::new(|req| {
                    let output = last_tool_output(req, "c-bash");
                    assert!(output.contains(r#"\"stdout\":\"nightjar\\n\""#), "{output}");
                    assert!(output.contains(r#""exit_code":0"#), "{output}");
                }),
                Message::text(Role::Assistant, "The codename in lowercase is nightjar."),
            ),
        ];
        let provider = Arc::new(PlannedProvider {
            steps: Mutex::new(steps.into()),
            calls: Mutex::default(),
        });

        let mut agent = AgentRunner::new(
            config(),
            provider.clone(),
            Arc::new(registry),
            store.clone(),
            "it-session",
        )
        .unwrap();
        let mut events = agent.subscribe();
        let collector = tokio::spawn(async move {
            let mut seen = Vec::new();
            while let Ok(event) = events.recv().await {
                seen.push(event);
            }
            seen
        });

        let outcome = agent
            .run("What is the release codename, in lowercase?")
            .await
            .unwrap();
        assert_eq!(outcome.status, AgentStatus::AwaitingInput);
        assert_eq!(outcome.turns, 3);
        assert_eq!(
            outcome.output.as_deref(),
            Some("The codename in lowercase is nightjar.")
        );
        assert_eq!(*provider.calls.lock().unwrap(), 3);
        assert_eq!(
            std::fs::read_to_string(workspace.path().join("name.txt")).unwrap(),
            "nightjar\n"
        );

        drop(agent);
        let seen = collector.await.unwrap();
        let invoked: Vec<_> = seen
            .iter()
            .filter_map(|e| match e {
                AgentEvent::ToolInvoked { name, .. } => Some(name.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(invoked, ["memory_read", "bash"]);
        assert!(seen.iter().all(|e| !matches!(
            e,
            AgentEvent::ToolCompleted {
                outcome: ToolOutcome::Failed { .. } | ToolOutcome::Skipped { .. },
                ..
            }
        )));
        assert!(matches!(
            seen.first(),
            Some(AgentEvent::TurnStarted { turn: 1, .. })
        ));
        assert!(matches!(
            seen.last(),
            Some(AgentEvent::TurnCompleted { turn: 3, .. })
        ));

        let store = store.lock().unwrap();
        for id in [
            "it-session/input/1",
            "it-session/turn/1",
            "it-session/turn/1/tool/0",
            "it-session/turn/2",
            "it-session/turn/2/tool/0",
            "it-session/turn/3",
        ] {
            let record = store.get(id).unwrap().expect(id);
            assert_eq!(record.trust, "untrusted", "{id}");
        }
        let bash = store.get("it-session/turn/2/tool/0").unwrap().unwrap();
        assert!(bash.content.contains("tr A-Z a-z") && bash.content.contains("nightjar"));
        let recalled = store
            .search("codename", lain_memory::SearchOptions::default())
            .unwrap();
        assert_eq!(
            recalled.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            ["fact-codename"]
        );
    }

    #[tokio::test]
    async fn hermes_task_reflects_at_completion_and_recalls_rules_in_a_new_session() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("memory.sqlite");
        let store = Arc::new(Mutex::new(MemoryStore::open(&path).unwrap()));
        let mut hermes_config = config();
        hermes_config.tool_call_mode = ToolCallMode::HermesTags;
        let steps: Vec<(Check, Message)> = vec![
            (
                Box::new(|request| {
                    assert!(request.tools.is_empty());
                    let prefix = request
                        .messages
                        .first()
                        .unwrap()
                        .content
                        .as_deref()
                        .unwrap();
                    assert!(prefix.contains("<tool_call>") && prefix.contains("UpdateScratchpad"));
                }),
                Message::text(
                    Role::Assistant,
                    r#"<tool_call>{"name":"UpdateScratchpad","arguments":{"plan":"verify codename"}}</tool_call>"#,
                ),
            ),
            (
                Box::new(|request| {
                    assert_eq!(request.messages.len(), 2);
                    assert!(request
                        .messages
                        .first()
                        .unwrap()
                        .content
                        .as_deref()
                        .unwrap()
                        .contains("verify codename"));
                }),
                Message::text(
                    Role::Assistant,
                    r#"Checking. <tool_call>{"name":"unregistered","arguments":{}}</tool_call>"#,
                ),
            ),
            (
                Box::new(|request| {
                    let last = request.messages.last().unwrap();
                    assert_eq!(last.role, Role::User);
                    let content = last.content.as_deref().unwrap();
                    assert!(
                        content.starts_with("<tool_response>")
                            && content.contains("TOOL_NOT_FOUND")
                    );
                    assert!(request
                        .messages
                        .iter()
                        .all(|message| message.tool_calls.is_empty()
                            && message.tool_call_id.is_none()));
                }),
                Message::text(Role::Assistant, "I couldn't verify the codename."),
            ),
        ];
        let provider = Arc::new(PlannedProvider {
            steps: Mutex::new(steps.into()),
            calls: Mutex::default(),
        });
        let tools = Arc::new(ToolRegistry::new());
        let mut agent = AgentRunner::new(
            hermes_config,
            provider.clone(),
            tools.clone(),
            store.clone(),
            "hermes-it",
        )
        .unwrap();
        let outcome = agent.run("verify the release codename").await.unwrap();
        assert_eq!(outcome.status, AgentStatus::AwaitingInput);
        assert_eq!(outcome.turns, 3);
        assert_eq!(*provider.calls.lock().unwrap(), 3);
        {
            let store = store.lock().unwrap();
            let rules = store.procedural_rules("hermes-it").unwrap();
            assert_eq!(rules.len(), 1);
            assert!(rules.first().unwrap().contains("failed tool"));
            assert!(store.get("hermes-it/turn/1").unwrap().is_none());
            assert!(store.get("hermes-it/turn/2/tool/0").unwrap().is_some());
        }
        let reflection = agent
            .record_feedback(UserFeedback::NeedsCorrection)
            .await
            .unwrap();
        assert_eq!(
            (
                reflection.turns,
                reflection.tool_calls,
                reflection.tool_errors
            ),
            (3, 2, 1)
        );
        assert_eq!(reflection.feedback, Some(UserFeedback::NeedsCorrection));
        assert_eq!(reflection.rules.len(), 2);
        assert_eq!(
            agent.reflect_and_compact("hermes-it").await.unwrap(),
            reflection
        );
        drop(agent);
        drop(store);

        let store = Arc::new(Mutex::new(MemoryStore::open(&path).unwrap()));
        {
            let store = store.lock().unwrap();
            assert_eq!(
                store.scratchpad("hermes-it").unwrap().as_deref(),
                Some("verify codename")
            );
            assert_eq!(
                store.procedural_rules("hermes-it").unwrap(),
                reflection.rules
            );
        }

        let next: Vec<(Check, Message)> = vec![(
            Box::new(|request| {
                let prefix = request
                    .messages
                    .first()
                    .unwrap()
                    .content
                    .as_deref()
                    .unwrap();
                assert!(
                    prefix.contains("Learned procedural heuristics")
                        && prefix.contains("corrected requirement")
                );
                assert!(
                    !prefix.contains("Current scratchpad") && !prefix.contains("verify codename")
                );
            }),
            Message::text(Role::Assistant, "Starting with verification."),
        )];
        let next_provider = Arc::new(PlannedProvider {
            steps: Mutex::new(next.into()),
            calls: Mutex::default(),
        });
        let mut next_agent =
            AgentRunner::new(config(), next_provider, tools, store, "next-it").unwrap();
        next_agent.run("check the codename").await.unwrap();
        assert!(next_agent.state().scratchpad.plan.is_empty());
    }
}
