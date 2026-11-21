mod client;
mod framing;
mod protocol;
mod server;
mod transport;

pub use client::IpcClient;
pub use protocol::{
    ClientFrame, Command, Event, RequestId, ServerFrame, EVENT_CAPACITY, MAX_FRAME_SIZE,
    PROTOCOL_VERSION,
};
pub use server::{CommandHandler, EventSink, IpcServer};
pub use transport::{Endpoint, DEFAULT_PIPE_NAME};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error("IPC frame exceeds the size limit")]
    FrameTooLarge,
    #[error("IPC connection closed")]
    Closed,
    #[error("IPC request id space exhausted")]
    RequestIdsExhausted,
    #[error("Too many unrelated replies; use send/recv for multiplexed requests")]
    MultiplexedRequest,
}
