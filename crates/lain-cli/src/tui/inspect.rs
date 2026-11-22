use std::{collections::BTreeMap, io::Read, path::PathBuf, time::Duration};

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use lain_ipc::{Command, Event, IpcClient, SessionInfo, SessionMode};
use ratatui::{
    layout::{Constraint, Layout, Rect},
    style::{Modifier, Style},
    text::Line,
    widgets::{
        Block, Borders, Cell, List, ListItem, ListState, Paragraph, Row, Table, TableState, Wrap,
    },
    Frame,
};
use serde::Deserialize;

use super::{
    app::Screen,
    launch_view::fit,
    state::{Scroll, State},
    theme::*,
};
use crate::{render::clean, Error};

#[derive(Default)]
pub enum ReadState {
    #[default]
    Idle,
    Loading,
    Ready(Duration),
    Unavailable(String),
}

impl ReadState {
    fn label(&self, now: Duration) -> String {
        match self {
            Self::Idle => "not read yet · r refresh".into(),
            Self::Loading => "reading…".into(),
            Self::Ready(at) if now.saturating_sub(*at).as_secs() < 5 => "read just now".into(),
            Self::Ready(at) => format!("read {}s ago", now.saturating_sub(*at).as_secs()),
            Self::Unavailable(error) => {
                format!("not available over the socket yet or read failed: {error} · r retries")
            }
        }
    }
    fn ready(&self) -> bool {
        matches!(self, Self::Ready(_))
    }
}

#[derive(Default)]
pub struct Resource<T> {
    pub data: T,
    pub state: ReadState,
    generation: u64,
}

impl<T: Default> Resource<T> {
    fn reset(&mut self) {
        self.data = T::default();
        self.state = ReadState::Idle;
        self.generation = self.generation.wrapping_add(1);
    }
    pub fn accept(&mut self, data: T, now: Duration) {
        self.data = data;
        self.state = ReadState::Ready(now);
    }
    pub fn unavailable(&mut self, error: impl AsRef<str>) {
        self.data = T::default();
        self.state = ReadState::Unavailable(fit(&clean(error.as_ref()), 300));
    }
}

pub struct SessionRow {
    pub info: SessionInfo,
    pub input: Option<u64>,
    pub output: Option<u64>,
    pub cost: Option<f64>,
    pub age: Option<u64>,
}

impl From<SessionInfo> for SessionRow {
    fn from(mut info: SessionInfo) -> Self {
        info.id = clean(&info.id);
        info.model = info.model.map(|s| clean(&s));
        Self {
            info,
            input: None,
            output: None,
            cost: None,
            age: None,
        }
    }
}

pub struct MemoryEntry {
    pub kind: &'static str,
    pub text: String,
}

#[derive(Deserialize)]
struct Provider {
    kind: String,
}
#[derive(Deserialize)]
struct ConfigMetadata {
    model: String,
    provider: Provider,
    context_window_tokens: Option<usize>,
}

pub struct ConfigModel {
    pub model: String,
    pub provider: String,
    pub window: Option<usize>,
}

#[derive(Default)]
pub struct Inspect {
    pub demo: bool,
    pub sessions: Resource<Vec<SessionRow>>,
    pub daemon: Resource<String>,
    pub memory: Resource<Vec<MemoryEntry>>,
    pub config: Resource<Vec<ConfigModel>>,
    pub config_path: PathBuf,
    pub session_selected: usize,
    pub memory_selected: usize,
    pub filter: String,
    pub filtering: bool,
    pub pid: Option<u32>,
    pub uptime: Option<u64>,
}

impl Inspect {
    pub fn reset_socket(&mut self) {
        self.sessions.reset();
        self.daemon.reset();
        self.memory.reset();
        self.session_selected = 0;
        self.memory_selected = 0;
    }

    pub fn demo_refresh(&mut self, screen: Screen, now: Duration) {
        self.demo = true;
        if screen == Screen::Sessions && matches!(self.sessions.state, ReadState::Idle) {
            self.sessions.accept(
                (0..8)
                    .map(|i| SessionRow {
                        info: SessionInfo {
                            id: format!("demo-local-{:02}", i + 1),
                            model: Some(
                                if i % 2 == 0 {
                                    "openai:gpt-4o"
                                } else {
                                    "local:qwen2.5-coder"
                                }
                                .into(),
                            ),
                            mode: Some(if i % 3 == 0 {
                                SessionMode::Architect
                            } else {
                                SessionMode::Code
                            }),
                            turn_count: i + 2,
                        },
                        input: Some(u64::from((i + 1) * 1200)),
                        output: Some(u64::from((i + 1) * 340)),
                        cost: Some(f64::from(i + 1) * 0.0128),
                        age: Some(u64::from(i + 1) * 180),
                    })
                    .collect(),
                now,
            );
            self.daemon.accept(
                "ready · OFFLINE DEMO · synthetic data; no daemon contacted".into(),
                now,
            );
            self.pid = Some(18432);
            self.uptime = Some(7980);
        }
        if screen == Screen::Memory && matches!(self.memory.state, ReadState::Idle) {
            self.memory.accept(vec![
                MemoryEntry {kind:"rule",text:"Scripts run unsandboxed as the host user. Review source and capabilities before testing or publishing.".into()},
                MemoryEntry {kind:"rule",text:"Require observed evidence before claiming verification. Prepared work is not verified execution.".into()},
                MemoryEntry {kind:"episode",text:"Creator review: inspected plugin manifests and prepared a test proposal. No script was executed in this offline demo.".into()},
            ],now);
        }
        if screen == Screen::Models && matches!(self.config.state, ReadState::Idle) {
            self.config_path = "demo/lain.json".into();
            self.config.accept(
                vec![
                    ConfigModel {
                        model: "openai:gpt-4o".into(),
                        provider: "open_ai_compatible".into(),
                        window: Some(1_000_000),
                    },
                    ConfigModel {
                        model: "local:qwen2.5-coder".into(),
                        provider: "open_ai_compatible".into(),
                        window: Some(32768),
                    },
                ],
                now,
            );
        }
    }

    fn load_config(&mut self, now: Duration) {
        let read = || -> Result<ConfigMetadata, ()> {
            if !std::fs::metadata(&self.config_path)
                .map_err(|_| ())?
                .is_file()
            {
                return Err(());
            }
            let mut bytes = vec![];
            std::fs::File::open(&self.config_path)
                .map_err(|_| ())?
                .take(1_048_577)
                .read_to_end(&mut bytes)
                .map_err(|_| ())?;
            if bytes.len() > 1_048_576 {
                return Err(());
            }
            serde_json::from_slice(&bytes).map_err(|_| ())
        };
        match read() {
            Ok(c) if !c.model.trim().is_empty() && c.provider.kind == "open_ai_compatible" => {
                self.config.accept(
                    vec![ConfigModel {
                        model: clean(&c.model),
                        provider: c.provider.kind,
                        window: c.context_window_tokens,
                    }],
                    now,
                )
            }
            _ => {
                self.config.data.clear();
                self.config.state=ReadState::Unavailable("Local config metadata unavailable (unreadable, invalid, or unsupported format)".into());
            }
        }
    }

    fn memory_rows(&self) -> Vec<&MemoryEntry> {
        let query = self.filter.to_lowercase();
        self.memory
            .data
            .iter()
            .filter(|entry| {
                format!("{} {}", entry.kind, entry.text)
                    .to_lowercase()
                    .contains(&query)
            })
            .collect()
    }

    pub fn key(
        &mut self,
        screen: Screen,
        key: KeyEvent,
        scroll: &mut Scroll,
    ) -> Option<&'static str> {
        if screen == Screen::Memory && self.filtering {
            match key.code {
                KeyCode::Esc => {
                    self.filter.clear();
                    self.filtering = false;
                }
                KeyCode::Enter => self.filtering = false,
                KeyCode::Backspace => {
                    self.filter.pop();
                }
                KeyCode::Char(c)
                    if !key
                        .modifiers
                        .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                        && self.filter.len() < 512 =>
                {
                    self.filter.push(c)
                }
                _ => {}
            }
            self.memory_selected = 0;
            scroll.memory_detail = 0;
            return None;
        }
        match (screen, key.code) {
            (Screen::Sessions, KeyCode::Down) => {
                self.session_selected =
                    (self.session_selected + 1).min(self.sessions.data.len().saturating_sub(1))
            }
            (Screen::Sessions, KeyCode::Up) => {
                self.session_selected = self.session_selected.saturating_sub(1)
            }
            (Screen::Sessions, KeyCode::Enter) => {
                return Some(if self.sessions.data.is_empty() {
                    "No session selected"
                } else {
                    "Attaching is not available over the socket yet; use lain ui."
                })
            }
            (Screen::Sessions, KeyCode::Char('r')) => {
                self.sessions.reset();
                self.daemon.reset();
                self.session_selected = 0;
            }
            (Screen::Memory, KeyCode::Char('/')) => self.filtering = true,
            (Screen::Memory, KeyCode::Char('r')) => {
                self.memory.reset();
                self.memory_selected = 0;
                scroll.memory_detail = 0;
            }
            (Screen::Memory, KeyCode::Esc) => {
                self.filter.clear();
                self.memory_selected = 0;
                scroll.memory_detail = 0;
            }
            (Screen::Memory, KeyCode::Down) => {
                self.memory_selected =
                    (self.memory_selected + 1).min(self.memory_rows().len().saturating_sub(1));
                scroll.memory_detail = 0;
            }
            (Screen::Memory, KeyCode::Up) => {
                self.memory_selected = self.memory_selected.saturating_sub(1);
                scroll.memory_detail = 0;
            }
            (Screen::Memory, KeyCode::PageDown) => {
                scroll.memory_detail = scroll
                    .memory_detail
                    .saturating_add(scroll.memory_page.max(1))
                    .min(scroll.memory_max)
            }
            (Screen::Memory, KeyCode::PageUp) => {
                scroll.memory_detail = scroll
                    .memory_detail
                    .saturating_sub(scroll.memory_page.max(1))
            }
            (Screen::Models, KeyCode::Char('r')) => self.config.reset(),
            _ => {}
        }
        None
    }
}

#[derive(Clone, Copy)]
enum Kind {
    Sessions,
    Daemon,
    Memory,
}
#[derive(Default)]
pub struct Requests {
    pending: BTreeMap<u64, (Kind, u64)>,
}

impl Requests {
    pub fn clear(&mut self) -> Vec<u64> {
        std::mem::take(&mut self.pending).into_keys().collect()
    }
    pub async fn ensure(
        &mut self,
        client: &mut IpcClient,
        view: &mut Inspect,
        screen: Screen,
        now: Duration,
    ) -> Result<(), Error> {
        let mut commands = vec![];
        if screen == Screen::Sessions {
            if matches!(view.sessions.state, ReadState::Idle) {
                view.sessions.state = ReadState::Loading;
                commands.push((
                    Kind::Sessions,
                    view.sessions.generation,
                    Command::ListSessions,
                ));
            }
            if matches!(view.daemon.state, ReadState::Idle) {
                view.daemon.state = ReadState::Loading;
                commands.push((
                    Kind::Daemon,
                    view.daemon.generation,
                    Command::GetStatus { session_id: None },
                ));
            }
        }
        if screen == Screen::Memory && matches!(view.memory.state, ReadState::Idle) {
            view.memory.state = ReadState::Loading;
            commands.push((
                Kind::Memory,
                view.memory.generation,
                Command::InspectMemory {
                    session_id: None,
                    limit: Some(50),
                },
            ));
        }
        if screen == Screen::Models && matches!(view.config.state, ReadState::Idle) {
            view.load_config(now);
        }
        for (kind, generation, command) in commands {
            self.pending
                .insert(client.send(command).await?, (kind, generation));
        }
        Ok(())
    }
    pub fn event(&mut self, id: u64, event: &Event, view: &mut Inspect, now: Duration) -> bool {
        let Some((kind, generation)) = self.pending.get(&id).copied() else {
            return false;
        };
        if !event.is_terminal() {
            return true;
        }
        self.pending.remove(&id);
        let error = match event {
            Event::Error { code, message } => format!("{}: {}", clean(code), clean(message)),
            _ => "Unsupported response from daemon".into(),
        };
        match kind {
            Kind::Sessions if generation == view.sessions.generation => match event {
                Event::Sessions { sessions } => {
                    view.sessions.accept(
                        sessions.iter().cloned().map(SessionRow::from).collect(),
                        now,
                    );
                    view.session_selected = 0;
                }
                _ => view.sessions.unavailable(error),
            },
            Kind::Daemon if generation == view.daemon.generation => match event {
                Event::Status {
                    session_id: None,
                    status,
                    ..
                } => view.daemon.accept(clean(status), now),
                _ => view.daemon.unavailable(error),
            },
            Kind::Memory if generation == view.memory.generation => match event {
                Event::Memory {
                    episodic,
                    procedural,
                } => {
                    view.memory.accept(
                        procedural
                            .iter()
                            .map(|text| MemoryEntry {
                                kind: "rule",
                                text: clean(text),
                            })
                            .chain(episodic.iter().map(|text| MemoryEntry {
                                kind: "episode",
                                text: clean(text),
                            }))
                            .collect(),
                        now,
                    );
                    view.memory_selected = 0;
                }
                _ => view.memory.unavailable(error),
            },
            _ => {}
        }
        true
    }
}

fn panel(title: impl Into<String>) -> Block<'static> {
    Block::default()
        .borders(Borders::ALL)
        .title(title.into())
        .border_style(Style::default().fg(MUTED))
}
fn line(text: impl AsRef<str>) -> Line<'static> {
    Line::raw(clean(text.as_ref()))
}
fn age(seconds: u64) -> String {
    if seconds < 60 {
        format!("{seconds}s")
    } else if seconds < 3600 {
        format!("{}m", seconds / 60)
    } else {
        format!("{}h {}m", seconds / 3600, seconds % 3600 / 60)
    }
}
fn cost(value: Option<f64>) -> Option<f64> {
    value.filter(|v| v.is_finite() && *v >= 0.0)
}

pub fn sessions(frame: &mut Frame, area: Rect, view: &Inspect, now: Duration) {
    let parts = Layout::vertical([
        Constraint::Length(5),
        Constraint::Length(1),
        Constraint::Min(5),
        Constraint::Length(2),
        Constraint::Length(1),
    ])
    .split(area);
    let Some(header) = parts.first() else {
        return;
    };
    let mut lines = vec![line(format!(
        "Daemon · {}",
        if view.daemon.state.ready() {
            view.daemon.data.clone()
        } else {
            view.daemon.state.label(now)
        }
    ))];
    if view.sessions.state.ready() {
        lines.push(line(format!(
            "{} live sessions · daemon memory only, not saved history",
            view.sessions.data.len()
        )));
    }
    let mut known = vec![];
    if let Some(pid) = view.pid {
        known.push(format!("pid {pid}"));
    }
    if let Some(up) = view.uptime {
        known.push(format!("uptime {}", age(up)));
    }
    if !known.is_empty() {
        lines.push(line(known.join(" · ")));
    }
    frame.render_widget(
        Paragraph::new(lines)
            .block(panel(format!(
                " Sessions · /{} · live sessions ",
                Screen::Sessions.id()
            )))
            .wrap(Wrap { trim: false }),
        *header,
    );
    if let Some(table) = parts.get(2) {
        let optional = [
            view.sessions.data.iter().any(|r| r.input.is_some()),
            view.sessions.data.iter().any(|r| r.output.is_some()),
            view.sessions.data.iter().any(|r| cost(r.cost).is_some()),
            view.sessions.data.iter().any(|r| r.age.is_some()),
        ];
        let mut names = vec!["ID", "Model", "Mode", "Turns"];
        let mut widths = vec![
            Constraint::Fill(2),
            Constraint::Fill(2),
            Constraint::Length(11),
            Constraint::Length(6),
        ];
        for (show, name) in optional
            .into_iter()
            .zip(["In tokens", "Out tokens", "Cost", "Age"])
        {
            if show {
                names.push(name);
                widths.push(Constraint::Length(10));
            }
        }
        let page = usize::from(table.height.saturating_sub(3)).max(1);
        let first = view
            .session_selected
            .saturating_sub(page - 1)
            .min(view.sessions.data.len().saturating_sub(1));
        let rows = view.sessions.data.iter().skip(first).take(page).map(|r| {
            let mut cells = vec![
                r.info.id.clone(),
                r.info.model.clone().unwrap_or_else(|| "—".into()),
                r.info.mode.map_or_else(|| "—".into(), |m| format!("{m:?}")),
                r.info.turn_count.to_string(),
            ];
            if optional.first() == Some(&true) {
                cells.push(r.input.map_or_else(|| "—".into(), |n| n.to_string()));
            }
            if optional.get(1) == Some(&true) {
                cells.push(r.output.map_or_else(|| "—".into(), |n| n.to_string()));
            }
            if optional.get(2) == Some(&true) {
                cells.push(cost(r.cost).map_or_else(|| "—".into(), |n| format!("${n:.4}")));
            }
            if optional.get(3) == Some(&true) {
                cells.push(r.age.map_or_else(|| "—".into(), age));
            }
            Row::new(cells.into_iter().map(|s| Cell::from(clean(&s))))
        });
        let mut selection = TableState::default().with_selected(
            (!view.sessions.data.is_empty()).then_some(view.session_selected.saturating_sub(first)),
        );
        frame.render_stateful_widget(
            Table::new(rows, widths)
                .header(
                    Row::new(names).style(Style::default().fg(CYAN).add_modifier(Modifier::BOLD)),
                )
                .block(panel(" Session catalog "))
                .column_spacing(1)
                .row_highlight_style(Style::default().bg(PANEL).fg(CYAN))
                .highlight_symbol("› "),
            *table,
            &mut selection,
        );
        if view.sessions.data.is_empty() {
            let text = if view.sessions.state.ready() {
                "No live sessions".into()
            } else {
                view.sessions.state.label(now)
            };
            frame.render_widget(
                Paragraph::new(text).wrap(Wrap { trim: false }),
                Rect::new(
                    table.x + 2,
                    table.y + 2,
                    table.width.saturating_sub(4),
                    table.height.saturating_sub(3),
                ),
            );
        }
        if let Some(status) = parts.get(4) {
            let n = view.sessions.data.len();
            let end = (first + page).min(n);
            let rows = if view.sessions.state.ready() {
                format!("rows {}-{end}/{n}", if n == 0 { 0 } else { first + 1 })
            } else {
                "rows unavailable".into()
            };
            frame.render_widget(
                Paragraph::new(format!("{rows} · {}", view.sessions.state.label(now)))
                    .style(Style::default().fg(MUTED)),
                *status,
            );
        }
    }
    if let Some(note) = parts.get(3) {
        frame.render_widget(
            Paragraph::new(
                "Read only · attaching is not available over the socket yet. Use lain ui.",
            )
            .style(Style::default().fg(MUTED)),
            *note,
        );
    }
}

pub fn memory(frame: &mut Frame, area: Rect, view: &Inspect, now: Duration, scroll: &mut Scroll) {
    let parts = Layout::vertical([
        Constraint::Length(5),
        Constraint::Length(3),
        Constraint::Min(4),
        Constraint::Length(2),
    ])
    .split(area);
    if let Some(header) = parts.first() {
        frame.render_widget(
            Paragraph::new(format!(
                "Workspace-wide episodic memory + procedural rules · recent 50 of each\n{}",
                view.memory.state.label(now)
            ))
            .style(Style::default().fg(MUTED))
            .block(panel(if view.demo {
                " Memory · /memory · OFFLINE DEMO · read only "
            } else {
                " Memory · /memory · read only "
            })),
            *header,
        );
    }
    if let Some(filter) = parts.get(1) {
        frame.render_widget(
            Paragraph::new(clean(&view.filter)).block(panel(if view.filtering {
                " Filter · typing · Enter apply · Esc clear "
            } else {
                " Filter · / edit "
            })),
            *filter,
        );
    }
    if let Some(body) = parts.get(2) {
        let cols = Layout::horizontal([Constraint::Percentage(40), Constraint::Percentage(60)])
            .split(*body);
        let rows = view.memory_rows();
        if let Some(left) = cols.first() {
            let items = rows.iter().map(|r| {
                ListItem::new(fit(
                    &format!("{} · {}", r.kind, r.text.lines().next().unwrap_or_default()),
                    usize::from(left.width.saturating_sub(5)),
                ))
            });
            let mut selected = ListState::default().with_selected(
                (!rows.is_empty())
                    .then_some(view.memory_selected.min(rows.len().saturating_sub(1))),
            );
            frame.render_stateful_widget(
                List::new(items)
                    .block(panel(format!(" {} entries ", rows.len())))
                    .highlight_style(Style::default().fg(CYAN).bg(PANEL))
                    .highlight_symbol("› "),
                *left,
                &mut selected,
            );
        }
        if let Some(right) = cols.get(1) {
            let text = rows.get(view.memory_selected).map_or_else(
                || "No matching memory".to_owned(),
                |r| format!("{}\n\n{}", r.kind, r.text),
            );
            let inner = panel(" Detail · PgUp/PgDn ").inner(*right);
            let paragraph = Paragraph::new(text).wrap(Wrap { trim: false });
            scroll.memory_page = inner.height.saturating_sub(1).max(1);
            scroll.memory_max = paragraph
                .line_count(inner.width.max(1))
                .saturating_sub(usize::from(inner.height))
                .min(usize::from(u16::MAX)) as u16;
            scroll.memory_detail = scroll.memory_detail.min(scroll.memory_max);
            frame.render_widget(
                paragraph
                    .scroll((scroll.memory_detail, 0))
                    .block(panel(" Detail · PgUp/PgDn ")),
                *right,
            );
        }
    }
    if let Some(note) = parts.get(3) {
        frame.render_widget(Paragraph::new("Read only · editing, deletion and semantic search are not available over the socket yet; use lain ui.")
        .style(Style::default().fg(MUTED)).wrap(Wrap {trim:false}),*note);
    }
}

pub fn models(frame: &mut Frame, area: Rect, state: &State, now: Duration) {
    let view = &state.inspect;
    let parts = Layout::vertical([
        Constraint::Length(9),
        Constraint::Length(1),
        Constraint::Min(5),
        Constraint::Length(3),
    ])
    .split(area);
    let mut lines = vec![line(format!(
        "Current model · {}",
        if state.model_chain == "model unknown" || state.model_chain.is_empty() {
            "unavailable"
        } else {
            &state.model_chain
        }
    ))];
    if state.context_window > 0 {
        let percent =
            (state.context as f64 / state.context_window as f64 * 100.0).clamp(0.0, 100.0) as usize;
        let filled = if state.context > 0 {
            (percent * 20).div_ceil(100).max(1)
        } else {
            0
        };
        lines.push(line(format!(
            "Context {}{} {percent}% · {}/{} tokens",
            "━".repeat(filled),
            "─".repeat(20 - filled),
            state.context,
            state.context_window
        )));
    }
    if let Some(tokens) = state.tokens_used() {
        lines.push(line(format!("Tokens used · {tokens}")));
    }
    if let Some(rate) = state.token_rate(now) {
        lines.push(line(format!("{rate:.1} tok/s · sampled locally")));
    }
    if let Some(value) = cost(state.cost) {
        lines.push(line(format!("cost ${value:.4}")));
    }
    if state.tokens_used().is_none() {
        lines.push(line(
            "Telemetry unavailable until the socket reports it; unknown values are omitted.",
        ));
    }
    lines.push(line(
        "Live socket telemetry has no pricing or per-direction token breakdown.",
    ));
    if let Some(header) = parts.first() {
        frame.render_widget(
            Paragraph::new(lines)
                .block(panel(if state.demo {
                    " Models · /models · OFFLINE DEMO · current session "
                } else {
                    " Models · /models · current session "
                }))
                .wrap(Wrap { trim: false }),
            *header,
        );
    }
    if let Some(catalog) = parts.get(2) {
        let mut lines = vec![
            line(format!("Config: {}", view.config_path.display())),
            line("Local metadata only; may differ from the running daemon session."),
            line(""),
        ];
        for model in &view.config.data {
            lines.push(Line::styled(
                format!("{} · {}", model.model, model.provider),
                Style::default().fg(CYAN),
            ));
            if let Some(window) = model.window {
                lines.push(line(format!("  configured context window: {window}")));
            }
        }
        if view.config.data.is_empty() {
            lines.push(line(match &view.config.state {
                ReadState::Unavailable(error) => format!("{error} · r reloads"),
                _ => "Local config metadata has not been read yet · r reloads".into(),
            }));
        }
        frame.render_widget(
            Paragraph::new(lines)
                .block(panel(" Configured locally · models / providers "))
                .wrap(Wrap { trim: false }),
            *catalog,
        );
    }
    if let Some(note) = parts.get(3) {
        frame.render_widget(Paragraph::new(concat!("Model selection is not available over the socket yet. Edit model/provider in the config above, ",
            "then use Ctrl+K → New session. No credentials are read from the environment."))
        .style(Style::default().fg(MUTED)).wrap(Wrap {trim:false}),*note);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replies_are_correlated_and_stale_refreshes_do_not_replace_data() {
        let mut requests = Requests::default();
        let mut view = Inspect::default();
        requests.pending.insert(1, (Kind::Sessions, 0));
        view.sessions.reset();
        assert!(requests.event(
            1,
            &Event::Sessions { sessions: vec![] },
            &mut view,
            Duration::ZERO
        ));
        assert!(matches!(view.sessions.state, ReadState::Idle));
        requests.pending.insert(2, (Kind::Memory, 0));
        requests.event(
            2,
            &Event::Memory {
                episodic: vec!["episode".into()],
                procedural: vec!["rule".into()],
            },
            &mut view,
            Duration::ZERO,
        );
        assert_eq!(view.memory.data.len(), 2);
        assert_eq!(view.memory.data.first().map(|r| r.kind), Some("rule"));
        requests.pending.insert(3, (Kind::Sessions, 1));
        requests.event(
            3,
            &Event::Error {
                code: "UNSUPPORTED".into(),
                message: "older daemon".into(),
            },
            &mut view,
            Duration::ZERO,
        );
        assert!(matches!(view.sessions.state, ReadState::Unavailable(_)));
        assert!(!requests.event(
            99,
            &Event::Pong { server_version: 1 },
            &mut view,
            Duration::ZERO
        ));
        assert_eq!(view.memory.data.len(), 2);
    }
    #[test]
    fn local_config_reads_only_metadata_without_building_a_provider(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("lain.json");
        let mut view = Inspect {
            config_path: path.clone(),
            ..Inspect::default()
        };
        view.load_config(Duration::ZERO);
        assert!(matches!(view.config.state, ReadState::Unavailable(_)));
        std::fs::write(
            &path,
            r#"{"model":"sample-model","provider":{"kind":"open_ai_compatible","api_key_env":"DELIBERATELY_UNSET_TUI_TEST"}}"#,
        )?;
        view.load_config(Duration::ZERO);
        assert!(view.config.state.ready());
        assert_eq!(
            view.config.data.first().map(|m| m.model.as_str()),
            Some("sample-model")
        );
        std::fs::write(&path, "invalid config")?;
        view.load_config(Duration::ZERO);
        assert!(view.config.data.is_empty());
        assert!(matches!(view.config.state, ReadState::Unavailable(_)));
        Ok(())
    }
}
