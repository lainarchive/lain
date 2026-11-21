#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use async_trait::async_trait;
    use futures::stream::BoxStream;
    use lain_core::{CoreError, provider::*, tools::*};
    use serde_json::json;

    #[derive(Debug, Default)]
    struct MockProvider {
        history: Mutex<Vec<CompletionRequest>>,
    }

    #[async_trait]
    impl ModelProvider for MockProvider {
        async fn complete(&self, req: CompletionRequest) -> Result<CompletionResponse, CoreError> {
            let mut history = self.history.lock().unwrap();
            history.push(req.clone());
            let mut message = Message::text(Role::Assistant, "done");
            if history.len() == 1 {
                message.content = None;
                message.tool_calls = vec![ToolCall {
                    id: "call-1".into(),
                    name: "bash".into(),
                    arguments: json!({"command":"echo hello"}),
                }];
            } else {
                let last = req.messages.last().unwrap();
                assert_eq!(last.role, Role::Tool);
                assert_eq!(last.tool_call_id.as_deref(), Some("call-1"));
                assert!(last.content.as_ref().unwrap().contains("hello"));
            }
            Ok(CompletionResponse {
                message,
                finish_reason: Some("stop".into()),
                usage: None,
            })
        }
        async fn stream(
            &self,
            _: CompletionRequest,
        ) -> Result<BoxStream<'static, Result<Token, CoreError>>, CoreError> {
            Err(CoreError::Protocol("mock only supports complete".into()))
        }
    }

    #[tokio::test]
    async fn agent_loop_preserves_tool_history() {
        let directory = tempfile::tempdir().unwrap();
        let mut registry = ToolRegistry::new();
        registry
            .register(Arc::new(BashTool {
                working_directory: directory.path().into(),
                timeout: Duration::from_secs(2),
                output_byte_cap: 1024,
            }))
            .unwrap();
        let provider = Arc::new(MockProvider::default());
        let model: Arc<dyn ModelProvider> = provider.clone();
        let mut request = CompletionRequest {
            model: "mock".into(),
            messages: vec![Message::text(Role::User, "say hello")],
            tools: registry.definitions(),
            temperature: None,
            max_tokens: None,
        };
        let response = model.complete(request.clone()).await.unwrap();
        request.messages.push(response.message.clone());
        request
            .messages
            .extend(registry.tool_messages(&response).await);
        let final_response = model.complete(request.clone()).await.unwrap();
        request.messages.push(final_response.message);
        assert_eq!(request.messages.len(), 4);
        assert_eq!(
            request.messages.last().unwrap().content.as_deref(),
            Some("done")
        );
        let history = provider.history.lock().unwrap();
        assert_eq!(history.len(), 2);
        assert_eq!(history.last().unwrap().messages.len(), 3);
    }
}
