use serde::Serialize;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt};

use crate::{Error, MAX_FRAME_SIZE};

pub(crate) async fn read_frame<R: AsyncBufRead + Unpin>(
    reader: &mut R,
) -> Result<Option<Vec<u8>>, Error> {
    let mut frame = Vec::new();
    let mut oversized = false;
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return if oversized {
                Err(Error::FrameTooLarge)
            } else if frame.is_empty() {
                Ok(None)
            } else {
                Ok(Some(frame))
            };
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let count = newline.map_or(available.len(), |index| index + 1);
        let data_len = if newline.is_some() { count - 1 } else { count };
        if frame.len() + data_len > MAX_FRAME_SIZE {
            oversized = true;
            frame.clear();
        }
        if !oversized {
            frame.extend(available.iter().take(data_len));
        }
        reader.consume(count);
        if newline.is_some() {
            return if oversized {
                Err(Error::FrameTooLarge)
            } else {
                Ok(Some(frame))
            };
        }
    }
}

pub(crate) async fn write_frame<W: AsyncWrite + Unpin, T: Serialize>(
    writer: &mut W,
    frame: &T,
) -> Result<(), Error> {
    let bytes = serde_json::to_vec(frame)?;
    if bytes.len() > MAX_FRAME_SIZE {
        return Err(Error::FrameTooLarge);
    }
    writer.write_all(&bytes).await?;
    writer.write_all(b"\n").await?;
    writer.flush().await?;
    Ok(())
}
