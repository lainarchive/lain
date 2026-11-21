use std::{future::Future, pin::Pin, sync::Arc};

use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    sync::{mpsc, watch},
    task::JoinSet,
};

use crate::{
    framing, protocol::decode_client, transport::Listener, Command, Endpoint, Error, Event,
    RequestId, ServerFrame, EVENT_CAPACITY,
};

pub trait CommandHandler: Send + Sync + 'static {
    fn handle(
        &self,
        command: Command,
        events: EventSink,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>>;
}

#[derive(Debug, Clone)]
pub struct EventSink(mpsc::Sender<Event>);

impl EventSink {
    pub async fn send(&self, event: Event) -> Result<(), Error> {
        self.0.send(event).await.map_err(|_| Error::Closed)
    }

    pub async fn closed(&self) {
        self.0.closed().await;
    }
}

#[derive(Debug)]
pub struct IpcServer {
    listener: Listener,
}

impl IpcServer {
    pub fn bind(endpoint: &Endpoint) -> Result<Self, Error> {
        Ok(Self {
            listener: Listener::bind(endpoint)?,
        })
    }

    /// Shutdown stops new commands and drains handlers and their event queues.
    /// Handlers must finish cooperatively; a client must keep reading until EOF.
    pub async fn serve<H: CommandHandler + ?Sized>(
        mut self,
        handler: Arc<H>,
        mut shutdown: watch::Receiver<bool>,
    ) -> Result<(), Error> {
        let mut connections = JoinSet::new();
        let result = loop {
            if *shutdown.borrow() {
                break Ok(());
            }
            tokio::select! {
                biased;
                _ = wait_shutdown(&mut shutdown) => break Ok(()),
                accepted = self.listener.accept() => match accepted {
                    Ok(stream) => { connections.spawn(connection(stream, handler.clone(), shutdown.clone())); }
                    Err(error) => break Err(error),
                },
                _ = connections.join_next(), if !connections.is_empty() => {}
            }
        };
        drop(self);
        if result.is_err() {
            connections.abort_all();
        }
        while connections.join_next().await.is_some() {}
        result
    }
}

async fn run_command<H: CommandHandler + ?Sized>(
    handler: Arc<H>,
    command: Command,
    id: RequestId,
    sender: mpsc::Sender<ServerFrame>,
) {
    let (events, mut receiver) = mpsc::channel(EVENT_CAPACITY);
    let handle = async { handler.handle(command, EventSink(events)).await };
    tokio::pin!(handle);
    let forward = async {
        while let Some(event) = receiver.recv().await {
            sender
                .send(ServerFrame::new(id, event))
                .await
                .map_err(|_| Error::Closed)?;
        }
        Ok::<(), Error>(())
    };
    tokio::pin!(forward);
    tokio::select! {
        _ = &mut handle => { let _ = forward.await; }
        _ = &mut forward => {}
        _ = sender.closed() => {}
    }
}

async fn connection<S, H>(stream: S, handler: Arc<H>, mut shutdown: watch::Receiver<bool>)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    H: CommandHandler + ?Sized,
{
    let (read, mut write) = tokio::io::split(stream);
    let (sender, mut receiver) = mpsc::channel::<ServerFrame>(EVENT_CAPACITY);
    let writer = tokio::spawn(async move {
        while let Some(frame) = receiver.recv().await {
            match framing::write_frame(&mut write, &frame).await {
                Err(Error::FrameTooLarge) => {
                    let error = ServerFrame::new(
                        frame.id,
                        Event::error("IPC_FRAME_TOO_LARGE", "Event exceeds frame limit"),
                    );
                    framing::write_frame(&mut write, &error).await?;
                }
                result => result?,
            }
        }
        write.shutdown().await?;
        Ok::<(), Error>(())
    });
    let mut reader = BufReader::new(read);
    let mut commands = JoinSet::new();
    let disconnected = loop {
        if *shutdown.borrow() {
            break false;
        }
        while commands.try_join_next().is_some() {}
        let frame = tokio::select! {
            biased;
            _ = wait_shutdown(&mut shutdown) => break false,
            _ = sender.closed() => break true,
            frame = framing::read_frame(&mut reader) => frame,
        };
        let reply = match frame {
            Ok(Some(bytes)) => match decode_client(&bytes) {
                Ok(frame) => {
                    commands.spawn(run_command(
                        handler.clone(),
                        frame.command,
                        frame.id,
                        sender.clone(),
                    ));
                    continue;
                }
                Err(error) => *error,
            },
            Ok(None) => break true,
            Err(Error::FrameTooLarge) => ServerFrame::new(
                0,
                Event::error("IPC_FRAME_TOO_LARGE", "Request exceeds frame limit"),
            ),
            Err(_) => break true,
        };
        if sender.send(reply).await.is_err() {
            break true;
        }
    };
    if disconnected {
        commands.abort_all();
    }
    let mut discard = [0; 1024];
    while !commands.is_empty() {
        tokio::select! {
            _ = commands.join_next() => {}
            _ = sender.closed() => commands.abort_all(),
            read = reader.read(&mut discard) => {
                if !matches!(read, Ok(count) if count > 0) {
                    commands.abort_all();
                }
            }
        }
    }
    drop(sender);
    let _ = writer.await;
}

async fn wait_shutdown(shutdown: &mut watch::Receiver<bool>) {
    while !*shutdown.borrow_and_update() {
        if shutdown.changed().await.is_err() {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn event_sink_backpressure_and_close() -> Result<(), Error> {
        let (sender, mut receiver) = mpsc::channel(EVENT_CAPACITY);
        let sink = EventSink(sender);
        for _ in 0..EVENT_CAPACITY {
            sink.send(Event::Pong {
                server_version: crate::PROTOCOL_VERSION,
            })
            .await?;
        }
        let send = sink.send(Event::Pong {
            server_version: crate::PROTOCOL_VERSION,
        });
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(10), send)
                .await
                .is_err()
        );
        assert!(receiver.recv().await.is_some());
        sink.send(Event::Pong {
            server_version: crate::PROTOCOL_VERSION,
        })
        .await?;
        drop(receiver);
        sink.closed().await;
        assert!(matches!(
            sink.send(Event::Pong {
                server_version: crate::PROTOCOL_VERSION
            })
            .await,
            Err(Error::Closed)
        ));
        Ok(())
    }
}
