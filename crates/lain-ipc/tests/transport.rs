#![cfg(unix)]

use std::{future::Future, pin::Pin, sync::Arc, time::Duration};

use lain_ipc::{
    Command, CommandHandler, Endpoint, Event, EventSink, IpcClient, IpcServer, ServerFrame,
    MAX_FRAME_SIZE, PROTOCOL_VERSION,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::UnixStream,
    sync::{watch, Notify},
    time::timeout,
};

type TestResult = Result<(), Box<dyn std::error::Error>>;

#[derive(Default)]
struct Mock {
    started: Notify,
    cancel: Notify,
    settled: Arc<Notify>,
}

struct Settled(Arc<Notify>);

impl Drop for Settled {
    fn drop(&mut self) {
        self.0.notify_one();
    }
}

impl CommandHandler for Mock {
    fn handle(
        &self,
        command: Command,
        events: EventSink,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            match command {
                Command::Ping => {
                    let _ = events
                        .send(Event::Pong {
                            server_version: PROTOCOL_VERSION,
                        })
                        .await;
                }
                Command::SendMessage {
                    session_id, text, ..
                } => {
                    if text == "wait" {
                        let _settled = Settled(self.settled.clone());
                        self.started.notify_one();
                        self.cancel.notified().await;
                    } else if text == "large" {
                        let _ = events
                            .send(Event::StreamToken {
                                session_id: session_id.clone(),
                                text: "x".repeat(MAX_FRAME_SIZE),
                            })
                            .await;
                    } else {
                        for text in text.split_whitespace() {
                            if events
                                .send(Event::StreamToken {
                                    session_id: session_id.clone(),
                                    text: text.into(),
                                })
                                .await
                                .is_err()
                            {
                                return;
                            }
                        }
                    }
                    let _ = events
                        .send(Event::SessionCompleted {
                            session_id,
                            reason: "done".into(),
                            scratchpad: Some("notes".into()),
                        })
                        .await;
                }
                Command::CancelTurn { .. } => {
                    self.cancel.notify_one();
                }
                _ => {
                    let _ = events
                        .send(Event::Error {
                            code: "UNSUPPORTED".into(),
                            message: "mock".into(),
                        })
                        .await;
                }
            }
        })
    }
}

#[tokio::test]
async fn roundtrip_stream_cancel_and_shutdown() -> TestResult {
    timeout(Duration::from_secs(10), async {
        let directory = tempfile::tempdir()?;
        let endpoint = Endpoint(directory.path().join("ipc.sock"));
        let server = IpcServer::bind(&endpoint)?;
        let handler = Arc::new(Mock::default());
        let (shutdown, receiver) = watch::channel(false);
        let task = tokio::spawn(server.serve(handler.clone(), receiver));
        let mut client = IpcClient::connect(&endpoint).await?;
        assert_eq!(client.request(Command::Ping).await?, vec![Event::Pong { server_version: PROTOCOL_VERSION }]);
        let events = client.request(Command::SendMessage { stream_deltas: false, session_id: "s".into(), text: "one two three".into() }).await?;
        assert_eq!(events.len(), 4);
        for (event, text) in events.iter().zip(["one", "two", "three"]) {
            assert_eq!(event, &Event::StreamToken { session_id: "s".into(), text: text.into() });
        }
        assert!(matches!(events.last(), Some(Event::SessionCompleted { scratchpad: Some(notes), .. }) if notes == "notes"));
        assert!(matches!(client.request(Command::SendMessage { stream_deltas: false, session_id: "s".into(), text: String::new() }).await?.as_slice(), [Event::SessionCompleted { .. }]));
        let running = client.send(Command::SendMessage { stream_deltas: false, session_id: "s".into(), text: "wait".into() }).await?;
        handler.started.notified().await;
        client.send(Command::CancelTurn { session_id: "s".into() }).await?;
        assert!(matches!(client.recv().await?, Some((id, Event::SessionCompleted { .. })) if id == running));
        shutdown.send(true)?;
        assert!(client.recv().await?.is_none());
        task.await??;
        assert!(!endpoint.0.exists());
        client.close().await?;
        Ok::<(), Box<dyn std::error::Error>>(())
    }).await?
}

async fn read_reply(
    reader: &mut BufReader<tokio::net::unix::OwnedReadHalf>,
) -> Result<ServerFrame, Box<dyn std::error::Error>> {
    let mut line = String::new();
    assert_ne!(reader.read_line(&mut line).await?, 0);
    Ok(serde_json::from_str(&line)?)
}

#[tokio::test]
async fn malformed_oversized_and_version_errors_keep_connection_alive() -> TestResult {
    timeout(Duration::from_secs(10), async {
        let directory = tempfile::tempdir()?;
        let endpoint = Endpoint(directory.path().join("ipc.sock"));
        let server = IpcServer::bind(&endpoint)?;
        let (shutdown, receiver) = watch::channel(false);
        let task = tokio::spawn(server.serve(Arc::new(Mock::default()), receiver));
        let (read, mut write) = UnixStream::connect(&endpoint.0).await?.into_split();
        let mut reader = BufReader::new(read);
        for bytes in [b"not json\n".as_slice(), b"\n".as_slice()] {
            write.write_all(bytes).await?;
            assert!(matches!(read_reply(&mut reader).await?.event, Event::Error { code, .. } if code == "IPC_INVALID_JSON"));
        }
        write.write_all(b"{\"version\":99,\"id\":44,\"command\":{\"type\":\"ping\"}}\n").await?;
        let error = read_reply(&mut reader).await?;
        assert_eq!(error.id, 44);
        assert!(matches!(error.event, Event::Error { code, .. } if code == "IPC_VERSION_MISMATCH"));
        write.write_all(&vec![b'x'; MAX_FRAME_SIZE + 1]).await?;
        write.write_all(b"\n").await?;
        assert!(matches!(read_reply(&mut reader).await?.event, Event::Error { code, .. } if code == "IPC_FRAME_TOO_LARGE"));
        write.write_all(b"{\"version\":1,\"id\":45,\"command\":{\"type\":\"ping\"}}\n").await?;
        let pong = read_reply(&mut reader).await?;
        assert_eq!(pong.id, 45);
        assert!(matches!(pong.event, Event::Pong { .. }));
        shutdown.send(true)?;
        task.await??;
        assert!(!endpoint.0.exists());
        Ok::<(), Box<dyn std::error::Error>>(())
    }).await?
}

#[tokio::test]
async fn bind_removes_stale_socket_but_preserves_regular_files() -> TestResult {
    let directory = tempfile::tempdir()?;
    let endpoint = Endpoint(directory.path().join("ipc.sock"));
    drop(std::os::unix::net::UnixListener::bind(&endpoint.0)?);
    let server = IpcServer::bind(&endpoint)?;
    assert!(IpcServer::bind(&endpoint).is_err());
    drop(server);
    assert!(!endpoint.0.exists());
    std::fs::write(&endpoint.0, b"keep")?;
    assert!(IpcServer::bind(&endpoint).is_err());
    assert_eq!(std::fs::read(&endpoint.0)?, b"keep");
    Ok(())
}

#[tokio::test]
async fn shutdown_drains_inflight_handler() -> TestResult {
    timeout(Duration::from_secs(10), async {
        let directory = tempfile::tempdir()?;
        let endpoint = Endpoint(directory.path().join("ipc.sock"));
        let handler = Arc::new(Mock::default());
        let server = IpcServer::bind(&endpoint)?;
        let (shutdown, receiver) = watch::channel(false);
        let task = tokio::spawn(server.serve(handler.clone(), receiver));
        let mut client = IpcClient::connect(&endpoint).await?;
        let id = client.send(Command::SendMessage { stream_deltas: false, session_id: "s".into(), text: "wait".into() }).await?;
        handler.started.notified().await;
        shutdown.send(true)?;
        handler.cancel.notify_one();
        assert!(matches!(client.recv().await?, Some((reply_id, Event::SessionCompleted { .. })) if reply_id == id));
        assert!(client.recv().await?.is_none());
        task.await??;
        Ok::<(), Box<dyn std::error::Error>>(())
    }).await?
}

#[tokio::test]
async fn oversized_output_and_client_send_are_errors() -> TestResult {
    timeout(Duration::from_secs(10), async {
        let directory = tempfile::tempdir()?;
        let endpoint = Endpoint(directory.path().join("ipc.sock"));
        let server = IpcServer::bind(&endpoint)?;
        let (shutdown, receiver) = watch::channel(false);
        let task = tokio::spawn(server.serve(Arc::new(Mock::default()), receiver));
        let mut client = IpcClient::connect(&endpoint).await?;
        assert!(matches!(client.send(Command::SendMessage { stream_deltas: false, session_id: "s".into(), text: "x".repeat(MAX_FRAME_SIZE) }).await,
            Err(lain_ipc::Error::FrameTooLarge)));
        let id = client.send(Command::SendMessage { stream_deltas: false, session_id: "s".into(), text: "large".into() }).await?;
        assert!(matches!(client.recv().await?, Some((reply_id, Event::Error { code, .. })) if reply_id == id && code == "IPC_FRAME_TOO_LARGE"));
        assert!(matches!(client.recv().await?, Some((reply_id, Event::SessionCompleted { .. })) if reply_id == id));
        client.close().await?;
        shutdown.send(true)?;
        task.await??;
        Ok::<(), Box<dyn std::error::Error>>(())
    }).await?
}

#[tokio::test]
async fn client_reports_server_version_and_invalid_json() -> TestResult {
    timeout(Duration::from_secs(10), async {
        let directory = tempfile::tempdir()?;
        let endpoint = Endpoint(directory.path().join("ipc.sock"));
        let listener = tokio::net::UnixListener::bind(&endpoint.0)?;
        let peer = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await?;
            stream.write_all(b"{\"version\":2,\"id\":6,\"event\":{\"type\":\"pong\",\"server_version\":2}}\ninvalid\n").await?;
            Ok::<(), std::io::Error>(())
        });
        let mut client = IpcClient::connect(&endpoint).await?;
        assert!(matches!(client.recv().await?, Some((6, Event::Error { code, .. })) if code == "IPC_VERSION_MISMATCH"));
        assert!(matches!(client.recv().await, Err(lain_ipc::Error::Json(_))));
        assert!(client.recv().await?.is_none());
        peer.await??;
        Ok::<(), Box<dyn std::error::Error>>(())
    }).await?
}

#[tokio::test]
async fn dropping_client_cancels_its_inflight_handlers() -> TestResult {
    timeout(Duration::from_secs(10), async {
        let directory = tempfile::tempdir()?;
        let endpoint = Endpoint(directory.path().join("ipc.sock"));
        let handler = Arc::new(Mock::default());
        let server = IpcServer::bind(&endpoint)?;
        let (shutdown, receiver) = watch::channel(false);
        let task = tokio::spawn(server.serve(handler.clone(), receiver));
        let mut client = IpcClient::connect(&endpoint).await?;
        client
            .send(Command::SendMessage {
                stream_deltas: false,
                session_id: "s".into(),
                text: "wait".into(),
            })
            .await?;
        handler.started.notified().await;
        drop(client);
        handler.settled.notified().await;
        shutdown.send(true)?;
        task.await??;
        Ok::<(), Box<dyn std::error::Error>>(())
    })
    .await?
}
