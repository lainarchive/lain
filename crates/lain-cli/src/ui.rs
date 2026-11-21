#[cfg(unix)]
use std::os::unix::process::CommandExt;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::{
    io::{self, BufRead, IsTerminal, Write},
    process::Stdio,
    time::Duration,
};

use crossterm::{
    cursor::MoveToColumn,
    queue,
    terminal::{Clear, ClearType},
};
use lain_ipc::{Command, Event, IpcClient};
use tokio::time::{interval, timeout, Instant};

use crate::{
    args::Options,
    render::{badge, clean, readable_status, render_scratchpad_box, SPINNER},
    Error,
};

#[derive(Debug)]
pub struct Renderer {
    fancy: bool,
    frame: usize,
}

impl Renderer {
    pub fn new(plain: bool) -> Self {
        Self {
            fancy: !plain && io::stdout().is_terminal() && io::stderr().is_terminal(),
            frame: 0,
        }
    }

    pub fn tick(&mut self) -> io::Result<()> {
        if self.fancy {
            let mut err = io::stderr().lock();
            queue!(err, MoveToColumn(0), Clear(ClearType::CurrentLine))?;
            write!(
                err,
                "{} working",
                SPINNER
                    .get(self.frame % SPINNER.len())
                    .copied()
                    .unwrap_or("*")
            )?;
            err.flush()?;
            self.frame = self.frame.wrapping_add(1);
        }
        Ok(())
    }

    pub fn clear(&self) -> io::Result<()> {
        if self.fancy {
            let mut err = io::stderr().lock();
            queue!(err, MoveToColumn(0), Clear(ClearType::CurrentLine))?;
            err.flush()?;
        }
        Ok(())
    }

    pub fn event(&self, event: &Event) -> io::Result<()> {
        self.clear()?;
        match event {
            Event::StreamToken { text, .. } => {
                let mut out = io::stdout().lock();
                write!(out, "{}", clean(text))?;
                if !text.ends_with('\n') {
                    writeln!(out)?;
                }
                out.flush()?;
            }
            Event::ToolStarted { name, .. } => {
                writeln!(io::stderr().lock(), "{}", badge(name, None, self.fancy))?
            }
            Event::ToolFinished { name, ok, .. } => writeln!(
                io::stderr().lock(),
                "{}",
                badge(name, Some(*ok), self.fancy)
            )?,
            Event::Status { status, .. } => {
                writeln!(io::stdout().lock(), "Status: {}", readable_status(status))?
            }
            Event::Memory {
                episodic,
                procedural,
            } => {
                let mut out = io::stdout().lock();
                writeln!(out, "Episodic memories (untrusted transcript):")?;
                if episodic.is_empty() {
                    writeln!(out, "(none)")?;
                }
                for item in episodic {
                    writeln!(out, "- {}", clean(item))?;
                }
                writeln!(out, "Procedural rules:")?;
                if procedural.is_empty() {
                    writeln!(out, "(none)")?;
                }
                for item in procedural {
                    writeln!(out, "- {}", clean(item))?;
                }
            }
            Event::SessionCompleted { reason, .. } if reason != "completed" => {
                writeln!(
                    io::stderr().lock(),
                    "Session ended: {}",
                    readable_status(reason)
                )?;
            }
            _ => {}
        }
        Ok(())
    }

    pub fn scratchpad(&self, text: &str) -> io::Result<()> {
        self.clear()?;
        let mut out = io::stdout().lock();
        if self.fancy {
            let width = crossterm::terminal::size()
                .map(|size| usize::from(size.0))
                .unwrap_or(80);
            for line in render_scratchpad_box(text, width) {
                writeln!(out, "{line}")?;
            }
        } else if !text.is_empty() {
            writeln!(out, "Scratchpad: {}", clean(text))?;
        }
        Ok(())
    }
}

impl Drop for Renderer {
    fn drop(&mut self) {
        let _ = self.clear();
    }
}

fn event_error(event: &Event) -> Option<Error> {
    match event {
        Event::Error { code, message } => {
            Some(Error::failure("DAEMON_ERROR", format!("{code}: {message}")))
        }
        _ => None,
    }
}

pub async fn request(
    client: &mut IpcClient,
    command: Command,
    renderer: &mut Renderer,
) -> Result<Event, Error> {
    let id = client.send(command).await?;
    let mut ticker = interval(Duration::from_millis(80));
    loop {
        tokio::select! {
            event = client.recv() => {
                let (reply_id, event) = event?.ok_or_else(|| Error::failure("DAEMON_CLOSED", "Daemon disconnected"))?;
                if reply_id != id { continue; }
                renderer.clear()?;
                if let Some(error) = event_error(&event) { return Err(error); }
                renderer.event(&event)?;
                if event.is_terminal() { return Ok(event); }
            }
            _ = ticker.tick() => renderer.tick()?,
        }
    }
}

async fn ping(options: &Options) -> Result<IpcClient, Error> {
    let mut client = IpcClient::connect(&options.endpoint).await?;
    let replies = client.request(Command::Ping).await?;
    if !matches!(
        replies.as_slice(),
        [Event::Pong {
            server_version: lain_ipc::PROTOCOL_VERSION
        }]
    ) {
        return Err(Error::failure(
            "DAEMON_PROTOCOL",
            "Daemon did not return a compatible Pong",
        ));
    }
    Ok(client)
}

pub async fn connect_or_spawn(options: &Options) -> Result<IpcClient, Error> {
    if let Ok(Ok(client)) = timeout(Duration::from_millis(300), ping(options)).await {
        return Ok(client);
    }
    let mut child = std::process::Command::new(std::env::current_exe()?);
    child
        .arg("daemon")
        .arg("--endpoint")
        .arg(&options.endpoint.0)
        .arg("--config")
        .arg(&options.config)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    child.process_group(0);
    #[cfg(windows)]
    child.creation_flags(0x08000200);
    let mut child = child.spawn()?;
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut delay = Duration::from_millis(25);
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(Error::failure(
                "DAEMON_START_TIMEOUT",
                "Daemon did not become ready within 5 seconds",
            ));
        }
        if let Ok(Ok(client)) =
            timeout(remaining.min(Duration::from_millis(300)), ping(options)).await
        {
            return Ok(client);
        }
        if let Some(status) = child.try_wait()? {
            return Err(Error::failure(
                "DAEMON_START_FAILED",
                format!("Daemon exited: {status}; run lain daemon in the foreground for details"),
            ));
        }
        tokio::time::sleep(delay.min(remaining)).await;
        delay = (delay * 2).min(Duration::from_millis(400));
    }
}

pub async fn start_session(
    client: &mut IpcClient,
    renderer: &mut Renderer,
) -> Result<String, Error> {
    match request(client, Command::StartSession { session_id: None }, renderer).await? {
        Event::SessionStarted { session_id } => Ok(session_id),
        _ => Err(Error::failure("DAEMON_PROTOCOL", "Expected SessionStarted")),
    }
}

pub async fn turn(
    client: &mut IpcClient,
    session: &str,
    text: String,
    renderer: &mut Renderer,
) -> Result<(bool, Option<String>), Error> {
    let (_, mut lines) = tokio::sync::mpsc::channel(1);
    turn_with_input(client, session, text, renderer, &mut lines).await
}

async fn turn_with_input(
    client: &mut IpcClient,
    session: &str,
    text: String,
    renderer: &mut Renderer,
    lines: &mut tokio::sync::mpsc::Receiver<io::Result<String>>,
) -> Result<(bool, Option<String>), Error> {
    let id = client
        .send(Command::SendMessage {
            session_id: session.into(),
            text,
        })
        .await?;
    let mut ticker = interval(Duration::from_millis(80));
    let mut cancelled = false;
    let mut input_open = true;
    loop {
        tokio::select! {
            event = client.recv() => {
                let (reply_id, event) = event?.ok_or_else(|| Error::failure("DAEMON_CLOSED", "Daemon disconnected"))?;
                if reply_id != id { continue; }
                renderer.clear()?;
                if let Some(error) = event_error(&event) { return Err(error); }
                renderer.event(&event)?;
                if let Event::SessionCompleted { reason, scratchpad, .. } = event { return Ok((reason == "completed", scratchpad)); }
            }
            signal = tokio::signal::ctrl_c(), if !cancelled => {
                signal?;
                client.send(Command::CancelTurn { session_id: session.into() }).await?;
                cancelled = true;
            }
            line = lines.recv(), if input_open => {
                match line {
                    Some(line) => {
                        if line?.trim() == "/cancel" && !cancelled {
                            client.send(Command::CancelTurn { session_id: session.into() }).await?;
                            cancelled = true;
                        }
                    }
                    None => input_open = false,
                }
            }
            _ = ticker.tick() => renderer.tick()?,
        }
    }
}

pub fn report_error(error: &Error) -> io::Result<()> {
    writeln!(io::stderr().lock(), "Error: {}", clean(&error.to_string()))
}

pub async fn interactive(client: &mut IpcClient, renderer: &mut Renderer) -> Result<(), Error> {
    let mut session = start_session(client, renderer).await?;
    let (sender, mut lines) = tokio::sync::mpsc::channel(16);
    // I keep blocking stdin off Tokio's pool so Ctrl-C can exit even while the terminal read is pending.
    std::thread::spawn(move || {
        for line in io::stdin().lock().lines() {
            if sender.blocking_send(line).is_err() {
                break;
            }
        }
    });
    let mut scratchpad = String::new();
    loop {
        renderer.scratchpad(&scratchpad)?;
        if io::stdin().is_terminal() {
            write!(io::stdout().lock(), "> ")?;
            io::stdout().lock().flush()?;
        }
        let line = tokio::select! { line = lines.recv() => line, signal = tokio::signal::ctrl_c() => { signal?; break; } };
        let Some(line) = line else {
            break;
        };
        let line = line?;
        let result = match line.trim() {
            "" => continue,
            "/quit" => break,
            "/status" => request(
                client,
                Command::GetStatus {
                    session_id: Some(session.clone()),
                },
                renderer,
            )
            .await
            .map(|event| {
                if let Event::Status {
                    scratchpad: Some(text),
                    ..
                } = event
                {
                    scratchpad = text;
                }
            }),
            "/memory" => request(
                client,
                Command::InspectMemory {
                    session_id: Some(session.clone()),
                    limit: Some(20),
                },
                renderer,
            )
            .await
            .map(|_| ()),
            "/cancel" => request(
                client,
                Command::CancelTurn {
                    session_id: session.clone(),
                },
                renderer,
            )
            .await
            .map(|_| ()),
            _ => match turn_with_input(client, &session, line, renderer, &mut lines).await {
                Ok((ok, plan)) => {
                    scratchpad = plan.unwrap_or_default();
                    if !ok {
                        session = start_session(client, renderer).await?;
                    }
                    Ok(())
                }
                Err(error) => Err(error),
            },
        };
        if let Err(error) = result {
            renderer.clear()?;
            report_error(&error)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use lain_ipc::{CommandHandler, Endpoint, EventSink, IpcServer};
    use std::{future::Future, pin::Pin, sync::Arc};
    use tokio::sync::{mpsc, watch, Notify};

    struct TurnHandler {
        started: Arc<Notify>,
        cancelled: Notify,
    }

    impl CommandHandler for TurnHandler {
        fn handle(
            &self,
            command: Command,
            events: EventSink,
        ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
            Box::pin(async move {
                match command {
                    Command::SendMessage { session_id, text } => {
                        self.started.notify_one();
                        if text == "wait" {
                            self.cancelled.notified().await;
                        }
                        let _ = events
                            .send(Event::SessionCompleted {
                                session_id,
                                reason: if text == "wait" {
                                    "cancelled"
                                } else {
                                    "completed"
                                }
                                .into(),
                                scratchpad: None,
                            })
                            .await;
                    }
                    Command::CancelTurn { .. } => {
                        self.cancelled.notify_one();
                    }
                    _ => {}
                }
            })
        }
    }

    #[tokio::test]
    async fn turn_consumes_cancel_input_before_completion() -> Result<(), Box<dyn std::error::Error>>
    {
        timeout(Duration::from_secs(5), async {
            for mode in ["cancel", "eof", "error"] {
                let directory = tempfile::tempdir()?;
                #[cfg(unix)]
                let endpoint = Endpoint(directory.path().join("ipc.sock"));
                #[cfg(windows)]
                let endpoint = Endpoint(format!(r"\\.\pipe\lain-turn-{}-{}", std::process::id(), directory.path().file_name().unwrap_or_default().to_string_lossy()).into());
                let started = Arc::new(Notify::new());
                let handler = Arc::new(TurnHandler { started: started.clone(), cancelled: Notify::new() });
                let (stop, shutdown) = watch::channel(false);
                let server = tokio::spawn(IpcServer::bind(&endpoint)?.serve(handler, shutdown));
                let mut client = IpcClient::connect(&endpoint).await?;
                let (sender, mut lines) = mpsc::channel(4);
                let input = tokio::spawn(async move {
                    started.notified().await;
                    match mode {
                        "cancel" => {
                            sender.send(Ok("ignored input".into())).await?;
                            sender.send(Ok("/status".into())).await?;
                            sender.send(Ok("/cancel".into())).await?;
                        }
                        "error" => sender.send(Err(io::Error::new(io::ErrorKind::InvalidData, "bad input"))).await?,
                        _ => {}
                    }
                    Ok::<(), mpsc::error::SendError<io::Result<String>>>(())
                });
                let text = if mode == "eof" { "normal" } else { "wait" };
                let result = turn_with_input(&mut client, "s", text.into(), &mut Renderer::new(true), &mut lines).await;
                if mode == "error" {
                    assert!(matches!(result, Err(Error::Io(error)) if error.kind() == io::ErrorKind::InvalidData));
                } else {
                    assert_eq!(result?, (mode == "eof", None));
                }
                input.await??;
                client.close().await?;
                stop.send(true)?;
                server.await??;
            }
            Ok::<(), Box<dyn std::error::Error>>(())
        }).await?
    }

    #[test]
    fn daemon_error_codes_appear_once() -> Result<(), Error> {
        for message in ["", "missing.json: No such file or directory"] {
            let event = Error::failure("CONFIG_NOT_FOUND", message).into_event();
            let error = event_error(&event)
                .ok_or_else(|| Error::failure("TEST", "Expected daemon error"))?;
            assert_eq!(
                error.to_string(),
                format!("DAEMON_ERROR: CONFIG_NOT_FOUND: {message}")
            );
        }
        let event =
            Error::Io(io::Error::new(io::ErrorKind::PermissionDenied, "denied")).into_event();
        assert!(
            matches!(event, Event::Error { code, message } if code == "CLI_IO" && message == "denied")
        );
        assert!(event_error(&Event::Pong { server_version: 1 }).is_none());
        Ok(())
    }
}
