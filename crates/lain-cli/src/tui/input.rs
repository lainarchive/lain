use std::{
    collections::BTreeSet,
    io,
    path::Path,
    process::Command as Process,
    time::{Duration, Instant},
};

use crossterm::{
    cursor::{Hide, Show},
    event::{Event as TerminalEvent, EventStream, KeyCode, KeyEvent, KeyEventKind, KeyModifiers},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use futures_util::StreamExt;
use lain_ipc::{Command, Event, IpcClient};
use ratatui::{backend::CrosstermBackend, Terminal};

use super::{
    state::{Effect, Phase, State},
    view,
};
use crate::{
    args::Options,
    ui::{self, Renderer},
    Error,
};

pub(super) fn handle_key(
    state: &mut State,
    key: KeyEvent,
    now: Duration,
    area: ratatui::layout::Rect,
) -> Effect {
    if view::has_room(area) {
        state.key(key, now)
    } else if (key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL))
        || (key.code == KeyCode::Char('q') && state.composer.is_empty())
    {
        Effect::Quit
    } else {
        Effect::None
    }
}

struct Screen;

impl Screen {
    fn enter() -> io::Result<Self> {
        enable_raw_mode()?;
        let screen = Self;
        execute!(io::stdout(), EnterAlternateScreen, Hide)?;
        Ok(screen)
    }
}

impl Drop for Screen {
    fn drop(&mut self) {
        let _ = execute!(io::stdout(), LeaveAlternateScreen, Show);
        let _ = disable_raw_mode();
    }
}

fn branch(cwd: &Path) -> String {
    let git = |args: &[&str]| {
        Process::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
    };
    git(&["symbolic-ref", "--quiet", "--short", "HEAD"])
        .or_else(|| git(&["rev-parse", "--short", "HEAD"]).map(|sha| format!("detached@{sha}")))
        .unwrap_or_else(|| "no git worktree".into())
}

async fn next(client: &mut Option<IpcClient>) -> Result<Option<(u64, Event)>, Error> {
    match client {
        Some(client) => Ok(client.recv().await?),
        None => std::future::pending().await,
    }
}

pub async fn run(options: &Options, demo: bool) -> Result<(), Error> {
    let cwd = std::env::current_dir()?;
    let mut state = if demo {
        State::sample()?
    } else {
        State::new(branch(&cwd), &cwd)?
    };
    let mut client = if demo {
        None
    } else {
        Some(ui::connect_or_spawn(options).await?)
    };
    let mut renderer = Renderer::new(true);
    let mut session = match &mut client {
        Some(client) => Some(ui::start_session(client, &mut renderer).await?),
        None => None,
    };
    if let (Some(client), Some(session)) = (&mut client, &session) {
        for command in [
            Command::GetTelemetry {
                session_id: session.clone(),
            },
            Command::InspectRules {
                session_id: None,
                limit: Some(20),
            },
        ] {
            for event in client.request(command).await? {
                if let Event::Error { code, message } = &event {
                    return Err(Error::failure("TUI_DAEMON", format!("{code}: {message}")));
                }
                state.event(&event, Duration::ZERO);
            }
        }
    }
    if demo {
        state.notice =
            "OFFLINE DEMO · synthetic verified evidence and advisor notes · no provider contacted"
                .into();
    }
    let _screen = Screen::enter()?;
    let mut terminal = Terminal::new(CrosstermBackend::new(io::stdout()))?;
    let mut keys = EventStream::new();
    let started = Instant::now();
    let mut tick = tokio::time::interval(Duration::from_millis(100));
    let mut last_poll = Duration::ZERO;
    let mut poll_request = None;
    let mut active_request = None;
    let mut ignored = BTreeSet::new();
    let result = async {
        loop {
            terminal.draw(|frame| {
                state.drawer_scroll = view::draw(frame, &state, started.elapsed());
            })?;
            tokio::select! {
                input = keys.next() => {
                    let Some(input) = input else { break; };
                    let TerminalEvent::Key(key) = input? else { continue; };
                    if key.kind == KeyEventKind::Release { continue; }
                    match handle_key(&mut state, key, started.elapsed(), terminal.get_frame().area()) {
                        Effect::Quit => break,
                        Effect::None => {}
                        Effect::Submit { text, read_only } => {
                            if let Some(client) = &mut client {
                                if session.is_none() {
                                    session = Some(ui::start_session(client, &mut renderer).await?);
                                }
                                if let Some(id) = &session {
                                    let command = if read_only { Command::SendReadOnlyMessage { session_id: id.clone(), text } }
                                        else { Command::SendMessage { session_id: id.clone(), text } };
                                    active_request = Some(client.send(command).await?);
                                }
                            } else { state.not_sent(started.elapsed()); }
                        }
                        Effect::Steer(text) => {
                            if let (Some(client), Some(id)) = (&mut client, &session) {
                                let command = if state.mode.read_only() { Command::SendReadOnlyMessage { session_id: id.clone(), text } }
                                    else { Command::SendMessage { session_id: id.clone(), text } };
                                client.send(command).await?;
                                state.notice = "Steer sent · current daemon rejects mid-turn SendMessage as SESSION_BUSY".into();
                            }
                        }
                        Effect::Rewind => {
                            if let Some(request) = active_request.take() { ignored.insert(request); }
                            if let (Some(client), Some(id)) = (&mut client, session.take()) {
                                client.send(Command::CancelTurn { session_id: id }).await?;
                            }
                            if let Some(request) = poll_request.take() { ignored.insert(request); }
                        }
                    }
                }
                event = next(&mut client) => {
                    let Some((request, event)) = event? else { return Err(Error::failure("TUI_DISCONNECTED", "Daemon closed the connection")); };
                    if ignored.contains(&request) { continue; }
                    if Some(request) == poll_request { poll_request = None; }
                    if Some(request) == active_request {
                        state.event(&event, started.elapsed());
                        if matches!(&event, Event::Error { code, .. } if code != "SESSION_BUSY") {
                            state.running = false;
                            if let Some(task) = state.active.as_ref().and_then(|id| state.tasks.get_mut(id)) { task.phase = Phase::Failed; }
                            ignored.insert(request);
                            active_request = None;
                            session = None;
                        }
                        if let Event::SessionCompleted { reason, .. } = &event {
                            active_request = None;
                            if reason != "completed" { session = None; }
                        }
                    } else {
                        if matches!(event, Event::Telemetry { .. } | Event::Status { .. } | Event::Memory { .. } | Event::Error { .. }) {
                            state.event(&event, started.elapsed());
                        }
                    }
                }
                _ = tick.tick() => {
                    if started.elapsed().saturating_sub(last_poll) >= Duration::from_secs(1) && poll_request.is_none() {
                        if let (Some(client), Some(id)) = (&mut client, &session) {
                            poll_request = Some(client.send(Command::GetTelemetry { session_id: id.clone() }).await?);
                        }
                        last_poll = started.elapsed();
                    }
                }
            }
        }
        Ok(())
    }.await;
    if let Some(mut client) = client {
        if state.running {
            if let Some(session_id) = session {
                let _ = client.send(Command::CancelTurn { session_id }).await;
            }
        }
        let _ = client.close().await;
    }
    result
}
