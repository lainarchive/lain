use std::time::Duration;

use lain_ipc::IpcClient;

use crate::{
    args::Options,
    ui::{self, Renderer},
    Error,
};

pub(super) fn delay(attempt: u32) -> Duration {
    Duration::from_millis(250u64.saturating_mul(1u64 << attempt.min(5))).min(Duration::from_secs(5))
}

pub(super) async fn retry(options: Options) -> (IpcClient, String) {
    let mut attempt = 0;
    loop {
        tokio::time::sleep(delay(attempt)).await;
        let connect = async {
            let mut client = ui::connect_or_spawn(&options).await?;
            let session = ui::start_session(&mut client, &mut Renderer::new(true)).await?;
            Ok::<_, Error>((client, session))
        };
        if let Ok(Ok(connection)) = tokio::time::timeout(Duration::from_secs(6), connect).await {
            return connection;
        }
        attempt = attempt.saturating_add(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_backoff_is_bounded() {
        let actual: Vec<_> = (0..8).map(|n| delay(n).as_millis()).collect();
        assert_eq!(actual, [250, 500, 1000, 2000, 4000, 5000, 5000, 5000]);
        assert_eq!(delay(u32::MAX), Duration::from_secs(5));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn dropped_socket_reconnects_with_a_new_session_and_keeps_the_draft(
    ) -> Result<(), Box<dyn std::error::Error>> {
        use lain_ipc::{ClientFrame, Command, Event, ServerFrame, PROTOCOL_VERSION};
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        tokio::time::timeout(Duration::from_secs(5),async {
            let directory=tempfile::tempdir()?;
            let endpoint=directory.path().join("fake.sock");
            let listener=tokio::net::UnixListener::bind(&endpoint)?;
            let server=tokio::spawn(async move {
                for session in ["before","after"] {
                    let (socket,_)=listener.accept().await?;
                    let (read,mut write)=socket.into_split();let mut lines=BufReader::new(read).lines();
                    while let Some(line)=lines.next_line().await? {
                        let frame:ClientFrame=serde_json::from_str(&line)?;
                        let event=match frame.command {
                            Command::Ping=>Event::Pong {server_version:PROTOCOL_VERSION},
                            Command::StartSession {..}=>Event::SessionStarted {session_id:session.into()},
                            Command::SendMessage {..}=>{write.shutdown().await?;break;},
                            Command::InspectRules {..}=>Event::Memory {episodic:vec![],procedural:vec!["fresh rule".into()]},
                            _=>return Err("unexpected fake-server request".into()),
                        };
                        let frame=ServerFrame {version:PROTOCOL_VERSION,id:frame.id,event};
                        write.write_all(format!("{}\n",serde_json::to_string(&frame)?).as_bytes()).await?;
                        if matches!(frame.event,Event::Memory {..}) {break;}
                    }
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
                Ok::<(),Box<dyn std::error::Error+Send+Sync>>(())
            });
            let options=Options::parse(["tui".into(),"--endpoint".into(),endpoint.to_string_lossy().into_owned()])?;
            let (mut first,old)=retry(options.clone()).await;
            let mut state=super::super::state::State::new("test".into(),directory.path())?;
            state.composer="unsent draft".into();
            first.send(Command::SendMessage {session_id:old.clone(),text:"drop now".into(),stream_deltas:true}).await?;
            assert!(first.recv().await?.is_none());state.disconnected(Duration::ZERO);drop(first);
            assert!(state.reconnecting);
            let (mut second,new)=retry(options).await;
            assert_ne!(new,old);state.reconnected(Duration::from_secs(1));state.session_id=Some(new);
            assert!(!state.reconnecting);assert_eq!(state.composer,"unsent draft");
            assert!(matches!(second.request(Command::InspectRules {session_id:None,limit:Some(20)}).await?.as_slice(),
                [Event::Memory {procedural,..}] if procedural==&["fresh rule"]));
            second.close().await?;server.await?.map_err(|error|error.to_string())?;
            Ok::<(),Box<dyn std::error::Error>>(())
        }).await?
    }
}
