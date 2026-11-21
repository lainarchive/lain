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
        AgentConfig, AgentEvent, AgentRunner, AgentStatus, ProviderSelection, ToolOutcome,
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
                    assert_eq!(names, ["bash", "memory_read"]);
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

        let mut config = AgentConfig::new(
            ProviderSelection::OpenAiCompatible {
                base_url: "http://127.0.0.1:9/v1".into(),
                api_key_env: None,
            },
            "planned",
        );
        config.system_prompt = "Use tools, then answer.".into();
        let mut agent = AgentRunner::new(
            config,
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
}
