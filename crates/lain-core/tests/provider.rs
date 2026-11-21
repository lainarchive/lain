#[cfg(test)]
mod tests {
    use futures::StreamExt;
    use lain_core::{CoreError, provider::*};
    use serde_json::{Value, json};
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    fn request() -> CompletionRequest {
        CompletionRequest {
            model: "mock".into(),
            messages: vec![Message::text(Role::User, "hello")],
            tools: vec![],
            temperature: None,
            max_tokens: None,
        }
    }

    async fn server(
        status: &str,
        body: String,
        streaming: bool,
    ) -> (String, tokio::task::JoinHandle<Value>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let status = status.to_owned();
        let handle = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0; 1024];
            let header_end = loop {
                let n = socket.read(&mut buffer).await.unwrap();
                assert_ne!(n, 0);
                bytes.extend(buffer.iter().take(n));
                if let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                    break end + 4;
                }
            };
            let headers = String::from_utf8_lossy(bytes.get(..header_end).unwrap()).to_lowercase();
            assert!(headers.starts_with("post /v1/chat/completions "));
            assert!(headers.contains("authorization: bearer test-key\r\n"));
            let length: usize = headers
                .lines()
                .find_map(|line| line.strip_prefix("content-length: "))
                .unwrap()
                .parse()
                .unwrap();
            while bytes.len() < header_end + length {
                let n = socket.read(&mut buffer).await.unwrap();
                assert_ne!(n, 0);
                bytes.extend(buffer.iter().take(n));
            }
            let request: Value =
                serde_json::from_slice(bytes.get(header_end..header_end + length).unwrap())
                    .unwrap();
            assert_eq!(request.get("stream").unwrap(), streaming);
            let content_type = if streaming {
                "text/event-stream"
            } else {
                "application/json"
            };
            let headers = format!(
                "HTTP/1.1 {status}\r\nContent-Length: {}\r\nContent-Type: {content_type}\r\n\
                 Connection: close\r\n\r\n",
                body.len()
            );
            socket.write_all(headers.as_bytes()).await.unwrap();
            for chunk in body.as_bytes().chunks(3) {
                socket.write_all(chunk).await.unwrap();
            }
            request
        });
        (format!("http://{address}/v1/"), handle)
    }

    #[test]
    fn wire_round_trips() {
        let call = ToolCall {
            id: "c1".into(),
            name: "bash".into(),
            arguments: json!({"command":"echo hi"}),
        };
        let mut message = Message::text(Role::Assistant, "");
        message.content = None;
        message.tool_calls.push(call.clone());
        let wire = serde_json::to_value(&message).unwrap();
        assert_eq!(wire.pointer("/tool_calls/0/type").unwrap(), "function");
        assert_eq!(
            wire.pointer("/tool_calls/0/function/arguments").unwrap(),
            r#"{"command":"echo hi"}"#
        );
        assert_eq!(serde_json::from_value::<Message>(wire).unwrap(), message);
        let definition = ToolDefinition {
            name: "bash".into(),
            description: "shell".into(),
            parameters: json!({"type":"object"}),
        };
        let wire = serde_json::to_value(&definition).unwrap();
        assert_eq!(wire.get("type").unwrap(), "function");
        assert_eq!(
            wire.pointer("/function/parameters").unwrap(),
            &json!({"type":"object"})
        );
        assert_eq!(
            serde_json::from_value::<ToolDefinition>(wire).unwrap(),
            definition
        );
        assert!(
            serde_json::from_value::<ToolCall>(
                json!({"id":"x","type":"function","function":{"name":"f","arguments":"invalid"}})
            )
            .is_err()
        );
        for role in [Role::System, Role::User, Role::Assistant, Role::Tool] {
            let message = Message::text(role, "");
            assert_eq!(
                serde_json::from_str::<Message>(&serde_json::to_string(&message).unwrap()).unwrap(),
                message
            );
        }
    }

    #[tokio::test]
    async fn completion_parses_calls_and_usage() {
        let body = json!({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [{
                        "id": "c1",
                        "type": "function",
                        "function": {"name": "bash", "arguments": "{\"command\":\"echo hi\"}"}
                    }]
                },
                "finish_reason": "tool_calls"
            }],
            "usage": {"prompt_tokens": 2, "completion_tokens": 3, "total_tokens": 5}
        });
        let (url, handle) = server("200 OK", body.to_string(), false).await;
        let response = OpenAiCompatibleProvider::new(url, Some("test-key".into()))
            .complete(request())
            .await
            .unwrap();
        assert_eq!(
            response.message.tool_calls.first().unwrap().arguments,
            json!({"command":"echo hi"})
        );
        assert_eq!(response.usage.unwrap().total_tokens, 5);
        handle.await.unwrap();
    }

    #[tokio::test]
    async fn sse_parses_text_and_tool_fragments() {
        let body = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"héllo\"},\"finish_reason\":null}]}\r\n\r\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c1\",\"function\":{\"name\":\"bash\",\"arguments\":\"{\"}}]}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
            "data: [DONE]\n\n"
        );
        let (url, handle) = server("200 OK", body.into(), true).await;
        let tokens: Vec<_> = OpenAiCompatibleProvider::new(url, Some("test-key".into()))
            .stream(request())
            .await
            .unwrap()
            .collect()
            .await;
        let tokens: Vec<_> = tokens.into_iter().collect::<Result<_, _>>().unwrap();
        assert_eq!(
            tokens,
            vec![
                Token::Text("héllo".into()),
                Token::ToolCall {
                    index: 0,
                    id: Some("c1".into()),
                    name: Some("bash".into()),
                    arguments: Some("{".into())
                },
                Token::ToolCall {
                    index: 0,
                    id: None,
                    name: None,
                    arguments: Some("}".into())
                },
                Token::Finished("tool_calls".into())
            ]
        );
        handle.await.unwrap();
    }

    #[tokio::test]
    async fn provider_errors_and_empty_stream() {
        for (status, body) in [
            ("401 Unauthorized", "denied"),
            ("200 OK", "not json"),
            ("200 OK", r#"{"choices":[]}"#),
        ] {
            let (url, handle) = server(status, body.into(), false).await;
            let result = OpenAiCompatibleProvider::new(url, Some("test-key".into()))
                .complete(request())
                .await;
            match status {
                "401 Unauthorized" => {
                    assert!(matches!(result, Err(CoreError::Status { status: 401, .. })))
                }
                _ if body == "not json" => assert!(matches!(result, Err(CoreError::Json(_)))),
                _ => assert!(matches!(result, Err(CoreError::Protocol(_)))),
            }
            handle.await.unwrap();
        }
        for body in [
            "data: [DONE]\n\n",
            "data: nope\n\n",
            "data: {\"choices\":[]}\n\n",
        ] {
            let (url, handle) = server("200 OK", body.into(), true).await;
            let mut stream = OpenAiCompatibleProvider::new(url, Some("test-key".into()))
                .stream(request())
                .await
                .unwrap();
            if body.contains("[DONE]") {
                assert!(stream.next().await.is_none());
            } else {
                assert!(stream.next().await.unwrap().is_err());
            }
            handle.await.unwrap();
        }
    }
}
