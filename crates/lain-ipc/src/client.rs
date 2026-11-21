use std::collections::VecDeque;

use tokio::{
    io::{AsyncWriteExt, BufReader, WriteHalf},
    sync::mpsc,
    task::JoinHandle,
};

use crate::{
    framing, transport, ClientFrame, Command, Endpoint, Error, Event, RequestId, ServerFrame,
    EVENT_CAPACITY, PROTOCOL_VERSION,
};

#[derive(Debug)]
pub struct IpcClient {
    writer: WriteHalf<transport::Stream>,
    receiver: mpsc::Receiver<Result<ServerFrame, Error>>,
    reader: JoinHandle<()>,
    next_id: RequestId,
    pending: VecDeque<ServerFrame>,
}

impl IpcClient {
    pub async fn connect(endpoint: &Endpoint) -> Result<Self, Error> {
        let (read, writer) = tokio::io::split(transport::connect(endpoint).await?);
        let (sender, receiver) = mpsc::channel(EVENT_CAPACITY);
        let reader = tokio::spawn(async move {
            let mut read = BufReader::new(read);
            loop {
                let frame = match framing::read_frame(&mut read).await {
                    Ok(Some(bytes)) => serde_json::from_slice::<ServerFrame>(&bytes)
                        .map_err(Error::from)
                        .map(|mut frame| {
                            if frame.version != PROTOCOL_VERSION {
                                frame.event = Event::error(
                                    "IPC_VERSION_MISMATCH",
                                    "Unsupported server protocol version",
                                );
                            }
                            frame
                        }),
                    Ok(None) => break,
                    Err(error) => Err(error),
                };
                let failed = frame.is_err();
                if sender.send(frame).await.is_err() || failed {
                    break;
                }
            }
        });
        Ok(Self {
            writer,
            receiver,
            reader,
            next_id: 1,
            pending: VecDeque::new(),
        })
    }

    pub async fn send(&mut self, command: Command) -> Result<RequestId, Error> {
        let id = self.next_id;
        self.next_id = id.checked_add(1).ok_or(Error::RequestIdsExhausted)?;
        framing::write_frame(
            &mut self.writer,
            &ClientFrame {
                version: PROTOCOL_VERSION,
                id,
                command,
            },
        )
        .await?;
        Ok(id)
    }

    pub async fn recv(&mut self) -> Result<Option<(RequestId, Event)>, Error> {
        let frame = match self.pending.pop_front() {
            Some(frame) => Some(frame),
            None => self.receiver.recv().await.transpose()?,
        };
        Ok(frame.map(|frame| (frame.id, frame.event)))
    }

    /// Use send/recv for multiplexed streams. This helper buffers unrelated replies
    /// up to EVENT_CAPACITY, then returns to the caller rather than growing unbounded.
    pub async fn request(&mut self, command: Command) -> Result<Vec<Event>, Error> {
        if self.pending.len() >= EVENT_CAPACITY {
            return Err(Error::MultiplexedRequest);
        }
        let id = self.send(command).await?;
        let mut events = Vec::new();
        while let Some(frame) = self.receiver.recv().await.transpose()? {
            if frame.id != id {
                self.pending.push_back(frame);
                if self.pending.len() >= EVENT_CAPACITY {
                    return Err(Error::MultiplexedRequest);
                }
                continue;
            }
            let terminal = frame.event.is_terminal();
            events.push(frame.event);
            if terminal {
                return Ok(events);
            }
        }
        Err(Error::Closed)
    }

    pub async fn close(mut self) -> Result<(), Error> {
        self.reader.abort();
        self.receiver.close();
        self.writer.shutdown().await?;
        Ok(())
    }
}

impl Drop for IpcClient {
    fn drop(&mut self) {
        self.reader.abort();
    }
}
