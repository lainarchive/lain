use std::{
    collections::BTreeSet,
    io,
    path::Path,
    process::Command as Process,
    time::{Duration, Instant},
};

use crossterm::{
    cursor::{Hide, Show},
    event::{
        DisableBracketedPaste, EnableBracketedPaste, Event as TerminalEvent, EventStream, KeyCode,
        KeyEvent, KeyEventKind, KeyModifiers,
    },
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use futures_util::StreamExt;
use lain_ipc::{Command, Event, IpcClient};
use ratatui::{backend::CrosstermBackend, Terminal};

use super::{
    creator_ipc, plugins,
    state::{Effect, State},
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
    if view::has_room(area, state) {
        state.key(key, now)
    } else if (key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL))
        || (key.code == KeyCode::Char('q')
            && state.composer.is_empty()
            && state.screen != super::app::Screen::Creator
            && !(state.screen == super::app::Screen::Memory && state.inspect.filtering)
            && !(state.screen == super::app::Screen::Plugins && state.plugins.filtering))
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
        execute!(
            io::stdout(),
            EnterAlternateScreen,
            EnableBracketedPaste,
            Hide
        )?;
        Ok(screen)
    }
}

impl Drop for Screen {
    fn drop(&mut self) {
        let _ = execute!(
            io::stdout(),
            DisableBracketedPaste,
            LeaveAlternateScreen,
            Show
        );
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

fn abandon_turn(
    session: &mut Option<String>,
    active: &mut Option<u64>,
    poll: &mut Option<u64>,
    ignored: &mut BTreeSet<u64>,
) -> Option<String> {
    ignored.extend(active.take());
    ignored.extend(poll.take());
    session.take()
}

fn finish_new_session(
    state: &mut State,
    mut candidate: State,
    event: &Event,
    now: Duration,
) -> Option<String> {
    match event {
        Event::SessionStarted { session_id } => {
            candidate.session_id = Some(session_id.clone());
            *state = candidate;
            state.notify("New session", now);
            Some(session_id.clone())
        }
        Event::Error { code, message } => {
            state.notify(format!("New session failed ({code}): {message}"), now);
            None
        }
        _ => {
            state.notify("New session failed: unexpected daemon response", now);
            None
        }
    }
}

pub async fn run(options: &Options, demo: bool) -> Result<(), Error> {
    let cwd = std::env::current_dir()?;
    let mut state = if demo {
        State::demo_turn()?
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
    let _screen = Screen::enter()?;
    let mut terminal = Terminal::new(CrosstermBackend::new(io::stdout()))?;
    let mut keys = EventStream::new();
    let started = Instant::now();
    let mut tick = tokio::time::interval(Duration::from_millis(100));
    let mut last_poll = Duration::ZERO;
    let mut poll_request = None;
    let mut active_request = None;
    let mut new_session: Option<(u64, State)> = None;
    let mut ignored = BTreeSet::new();
    let mut plugin_requests = plugins::Requests::default();
    let mut creator_requests = creator_ipc::Requests::default();
    let mut inspect_requests = super::inspect::Requests::default();
    let mut plugins_session = session.clone();
    let result = async {
        loop {
            if new_session.is_some() {state.notify("Starting a new session · Ctrl+C quits",started.elapsed());}
            if !demo {state.session_id = session.clone();state.inspect.config_path=options.config.clone();}
            if plugins_session != session {
                ignored.extend(plugin_requests.clear());
                ignored.extend(creator_requests.clear());
                ignored.extend(inspect_requests.clear());
                state.inspect.reset_socket();
                state.creator.reset_access();
                state.plugins.refresh();
                plugins_session = session.clone();
            }
            if (state.screen == super::app::Screen::Plugins || state.launch()) && !state.plugins.loaded {
                if let Some(client) = &mut client {
                    plugin_requests.refresh(client, session.as_deref(), &mut state.plugins).await?;
                } else { state.plugins.load_demo()?; }
            }
            if state.screen == super::app::Screen::Creator && !state.creator.access_loaded {
                if let Some(client) = &mut client {
                    creator_requests.access(client, session.as_deref(), &mut state.creator).await?;
                } else {state.creator.set_access(true);}
            }
            if let Some(client)=&mut client {
                inspect_requests.ensure(client,&mut state.inspect,state.screen,started.elapsed()).await?;
            } else {state.inspect.demo_refresh(state.screen,started.elapsed());}
            terminal.draw(|frame| {
                state.scroll = view::draw(frame, &state, started.elapsed());
            })?;
            tokio::select! {
                input = keys.next() => {
                    let Some(input) = input else { break; };
                    let input = input?;
                    if new_session.is_some() {
                        if matches!(&input,TerminalEvent::Key(key) if key.code==KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL)) {break;}
                        continue;
                    }
                    if let TerminalEvent::Paste(text) = &input {
                        if view::has_room(terminal.get_frame().area(), &state) {state.paste(text);}
                        continue;
                    }
                    let TerminalEvent::Key(key) = input else { continue; };
                    if key.kind == KeyEventKind::Release { continue; }
                    match handle_key(&mut state, key, started.elapsed(), terminal.get_frame().area()) {
                        Effect::Quit => break,
                        Effect::None => {}
                        Effect::Creator(operation) => {
                            state.scroll.creator_output = 0;
                            if let Some(client) = &mut client {
                                creator_requests.submit(client, session.as_deref(), &mut state.creator, state.mode, operation).await?;
                            } else if state.creator.request(state.mode, operation) != Effect::None {
                                if let Err(error) = state.creator.simulate(operation) {state.creator.error = Some(error);}
                            }
                        }
                        Effect::NewSession => {
                            match state.fresh_session() {
                                Ok(mut candidate)=> {
                                    if let Some(client)=&mut client {
                                        match client.send(Command::StartSession {session_id:None}).await {
                                            Ok(request)=>new_session=Some((request,candidate)),
                                            Err(error)=>state.notify(error.to_string(),started.elapsed()),
                                        }
                                    } else {
                                        candidate.demo_metadata(started.elapsed())?;
                                        state=candidate;
                                    }
                                }
                                Err(error)=>state.notify(error.to_string(),started.elapsed()),
                            }
                        }
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
                        Effect::Interrupt | Effect::Rewind => {
                            let cancelled=abandon_turn(&mut session,&mut active_request,&mut poll_request,&mut ignored);
                            if let (Some(client), Some(id)) = (&mut client, cancelled) {
                                ignored.insert(client.send(Command::CancelTurn { session_id:id }).await?);
                            }
                        }
                    }
                }
                event = next(&mut client) => {
                    let Some((request, event)) = event? else { return Err(Error::failure("TUI_DISCONNECTED", "Daemon closed the connection")); };
                    if ignored.contains(&request) { continue; }
                    if new_session.as_ref().is_some_and(|(id,_)|*id==request) {
                        if let Some((_,candidate))=new_session.take() {
                            if let Some(id)=finish_new_session(&mut state,candidate,&event,started.elapsed()) {
                                let old=abandon_turn(&mut session,&mut active_request,&mut poll_request,&mut ignored);
                                session=Some(id);
                                if let (Some(client),Some(old))=(&mut client,old) {
                                    ignored.insert(client.send(Command::CancelTurn {session_id:old}).await?);
                                }
                            }
                        }
                        continue;
                    }
                    if inspect_requests.event(request,&event,&mut state.inspect,started.elapsed()) {continue;}
                    if plugin_requests.event(request, &event, &mut state.plugins) {
                        if let Event::Tools {session_id, allow_creator_mode, ..} = &event {
                            if session.as_deref() == Some(session_id.as_str()) {state.creator.set_access(*allow_creator_mode);}
                        }
                        continue;
                    }
                    if creator_requests.event(request, &event, &mut state.creator) {continue;}
                    if Some(request) == poll_request { poll_request = None; }
                    if Some(request) == active_request {
                        state.event(&event, started.elapsed());
                        if let Event::Error {code,..} = &event {
                            state.reject_turn(code,started.elapsed());
                            ignored.insert(request);
                            active_request = None;
                            if code!="SESSION_BUSY" {session = None;}
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
                    state.tick(started.elapsed());
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn new_session_failure_preserves_the_old_conversation() -> Result<(), Box<dyn std::error::Error>>
    {
        let mut state = State::demo_turn()?;
        state.composer = "keep this draft".into();
        let count = state.tasks.len();
        state.overlay = Some(super::super::app::Overlay::Confirm(
            super::super::app::Action::NewSession,
        ));
        assert_eq!(
            state.key(
                crossterm::event::KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE),
                Duration::ZERO
            ),
            Effect::NewSession
        );
        assert_eq!(state.tasks.len(), count);
        let candidate = state.fresh_session()?;
        assert!(finish_new_session(
            &mut state,
            candidate,
            &Event::Error {
                code: "SESSION_LIMIT".into(),
                message: "full".into()
            },
            Duration::ZERO
        )
        .is_none());
        assert_eq!(state.composer, "keep this draft");
        assert_eq!(state.tasks.len(), count);
        assert!(state.running);
        let candidate = state.fresh_session()?;
        assert_eq!(
            finish_new_session(
                &mut state,
                candidate,
                &Event::SessionStarted {
                    session_id: "new".into()
                },
                Duration::ZERO
            ),
            Some("new".into())
        );
        assert!(state.tasks.is_empty());
        assert!(state.composer.is_empty());
        assert!(!state.running);
        Ok(())
    }
    #[test]
    fn abandoning_a_turn_quarantines_stream_and_poll_and_retires_its_session() {
        let mut session = Some("cancelled".into());
        let mut active = Some(10);
        let mut poll = Some(11);
        let mut ignored = BTreeSet::new();
        assert_eq!(
            abandon_turn(&mut session, &mut active, &mut poll, &mut ignored),
            Some("cancelled".into())
        );
        assert!(session.is_none() && active.is_none() && poll.is_none());
        assert_eq!(ignored, BTreeSet::from([10, 11]));
        assert_eq!(
            abandon_turn(&mut session, &mut active, &mut poll, &mut ignored),
            None
        );
    }
}
