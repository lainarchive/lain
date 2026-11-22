use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    path::Path,
    time::Duration,
};

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
#[cfg(test)]
use lain_harness::advisor::AdvisorKind;
use lain_harness::{
    advisor::AdvisorNote,
    dag::{Dag, Node},
    evidence::Status,
    scope::WriteScope,
};
use lain_ipc::Event;

use crate::{render::clean, Error};

use super::app::{self, Action, Overlay, Screen};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Architect,
    Code,
    Ask,
}

impl Mode {
    pub fn read_only(self) -> bool {
        self != Self::Code
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Architect => "Architect",
            Self::Code => "Code",
            Self::Ask => "Ask",
        }
    }
}

#[derive(Debug, PartialEq)]
pub enum Effect {
    Creator(super::creator::Operation),
    None,
    Submit { text: String, read_only: bool },
    Steer(String),
    Rewind,
    Interrupt,
    NewSession,
    Quit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Evidence(Status),
    Running,
    Failed,
    NotSent,
    Interrupted,
}

impl Phase {
    pub fn glyph(self) -> &'static str {
        match self {
            Self::Running => "●",
            Self::Failed => "×",
            Self::Interrupted => "■",
            Self::Evidence(Status::ObservedVerified) => "✓",
            Self::Evidence(Status::PreparedNotObserved) => "◇",
            Self::Evidence(Status::Planned) | Self::NotSent => "○",
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Failed => "failed",
            Self::Interrupted => "interrupted",
            Self::NotSent => "not sent",
            Self::Evidence(Status::ObservedVerified) => "verified",
            Self::Evidence(Status::PreparedNotObserved) => "prepared",
            Self::Evidence(Status::Planned) => "waiting",
        }
    }
}

#[derive(Debug)]
pub struct Task {
    pub prompt: String,
    pub node: Node,
    pub title: String,
    pub model: String,
    pub phase: Phase,
    pub started: Duration,
    pub ended: Option<Duration>,
    pub tokens: u64,
    pub text: String,
}

#[derive(Debug)]
pub struct ToolBlock {
    pub started: Duration,
    pub ended: Option<Duration>,
    pub node: String,
    pub call_id: String,
    pub name: String,
    pub arguments: String,
    pub output: String,
    pub ok: Option<bool>,
    pub expanded: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Selection {
    Layer(usize),
    Node(String),
    Tool(usize),
}

#[derive(Clone, Copy, Default)]
pub struct Scroll {
    pub help: u16,
    pub help_page: u16,
    pub help_max: u16,
    pub memory_detail: u16,
    pub memory_page: u16,
    pub memory_max: u16,
    pub transcript: usize,
    pub transcript_max: usize,
    pub transcript_page: usize,
    pub selection_epoch: u64,
    pub dag_visible: bool,
    pub plan_visible: bool,
    pub creator_output: u16,
    pub creator_page: u16,
    pub creator_max: u16,
    pub plugin_detail: u16,
    pub plugin_page: u16,
    pub plugin_max: u16,
    pub lane: usize,
    pub drawer: u16,
    pub plan: u16,
    pub rules: u16,
    pub lane_page: usize,
    pub drawer_page: u16,
    pub plan_page: u16,
    pub rules_page: u16,
}

pub struct State {
    pub inspect: super::inspect::Inspect,
    pub demo: bool,
    pub follow: bool,
    pub unseen: bool,
    pub dag_drawer: Option<bool>,
    pub plan_drawer: Option<bool>,
    pub dag_focus: bool,
    pub selection_epoch: u64,
    pub theme: super::theme::Theme,
    pub session_id: Option<String>,
    pub creator: super::creator::Creator,
    pub plugins: super::plugins::Plugins,
    pub screen: Screen,
    pub overlay: Option<Overlay>,
    pub toast: Option<(String, Duration)>,
    underlays: Vec<Overlay>,
    slash_selected: usize,
    slash_dismissed: bool,
    pub dag: Dag,
    pub tasks: BTreeMap<String, Task>,
    pub tools: Vec<ToolBlock>,
    pub notes: Vec<AdvisorNote>,
    pub mode: Mode,
    pub composer: String,
    pub branch: String,
    pub model_chain: String,
    pub cost: Option<f64>,
    pub context: usize,
    pub context_window: usize,
    pub plan: String,
    pub rules: Vec<String>,
    pub notice: String,
    pub running: bool,
    pub selected: Option<Selection>,
    pub collapsed_layers: BTreeSet<usize>,
    pub collapsed_nodes: BTreeSet<String>,
    pub scroll: Scroll,
    pub active: Option<String>,
    scope: WriteScope,
    last_prompt: String,
    escape: Option<Duration>,
    next_turn: u64,
    samples: VecDeque<(Duration, u64)>,
    total_tokens: u64,
}

impl State {
    pub fn new(branch: String, workspace: &Path) -> Result<Self, Error> {
        Ok(Self {
            inspect: super::inspect::Inspect {
                config_path: workspace.join("lain.json"),
                ..super::inspect::Inspect::default()
            },
            demo: false,
            follow: true,
            unseen: false,
            dag_drawer: None,
            plan_drawer: None,
            dag_focus: false,
            selection_epoch: 0,
            theme: super::theme::Theme::default(),
            session_id: None,
            creator: super::creator::Creator::default(),
            plugins: super::plugins::Plugins::default(),
            screen: Screen::Session,
            overlay: None,
            toast: None,
            underlays: vec![],
            slash_selected: 0,
            slash_dismissed: false,
            dag: Dag::new(vec![]).map_err(|e| Error::failure("TUI_DAG", e))?,
            scope: WriteScope::new(workspace, std::iter::empty::<&Path>())
                .map_err(|e| Error::failure("TUI_SCOPE", e))?,
            tasks: BTreeMap::new(),
            tools: vec![],
            notes: vec![],
            mode: Mode::Architect,
            composer: String::new(),
            branch,
            model_chain: "model unknown".into(),
            cost: None,
            context: 0,
            context_window: 0,
            plan: String::new(),
            rules: vec![],
            notice: "Ready · Architect: built-in reads only".into(),
            running: false,
            selected: None,
            collapsed_layers: BTreeSet::new(),
            collapsed_nodes: BTreeSet::new(),
            scroll: Scroll::default(),
            active: None,
            last_prompt: String::new(),
            escape: None,
            next_turn: 0,
            samples: VecDeque::new(),
            total_tokens: 0,
        })
    }

    fn rebuild(&mut self) -> Result<(), Error> {
        self.dag = Dag::new(self.tasks.values().map(|t| t.node.clone()).collect())
            .map_err(|e| Error::failure("TUI_DAG", e))?;
        Ok(())
    }

    pub fn selections(&self) -> Vec<Selection> {
        let mut rows = vec![];
        for (layer, nodes) in self.dag.layers().iter().enumerate() {
            rows.push(Selection::Layer(layer));
            if self.collapsed_layers.contains(&layer) {
                continue;
            }
            for node in nodes {
                rows.push(Selection::Node(node.id.clone()));
                if !self.collapsed_nodes.contains(&node.id) {
                    rows.extend(
                        self.tools
                            .iter()
                            .enumerate()
                            .filter(|(_, t)| t.node == node.id)
                            .map(|(i, _)| Selection::Tool(i)),
                    );
                }
            }
        }
        rows
    }

    #[cfg(test)]
    pub fn select_tool(&mut self, index: usize) {
        self.selected = Some(Selection::Tool(index));
    }

    pub fn tokens_used(&self) -> Option<u64> {
        (!self.samples.is_empty()).then_some(self.total_tokens)
    }

    pub fn token_rate(&self, now: Duration) -> Option<f64> {
        if self.demo {
            return Some(self.velocity(now));
        }
        let (first, _) = self.samples.front()?;
        let (last, _) = self.samples.back()?;
        let elapsed = last.saturating_sub(*first).as_secs_f64();
        (elapsed > 0.0 && now.saturating_sub(*last) <= Duration::from_secs(5)).then(|| {
            self.samples
                .iter()
                .skip(1)
                .map(|(_, count)| *count)
                .sum::<u64>() as f64
                / elapsed
        })
    }

    pub fn velocity(&self, now: Duration) -> f64 {
        if self.demo {
            return 38.6;
        }
        self.samples
            .iter()
            .filter(|(at, _)| now.saturating_sub(*at) <= Duration::from_secs(5))
            .map(|(_, count)| *count)
            .sum::<u64>() as f64
            / 5.0
    }

    pub fn notify(&mut self, text: impl Into<String>, now: Duration) {
        self.toast = Some((text.into(), now.saturating_add(Duration::from_secs(5))));
    }

    pub fn tick(&mut self, now: Duration) {
        if self.toast.as_ref().is_some_and(|(_, until)| now >= *until) {
            self.toast = None;
        }
    }

    pub fn toast_text(&self, now: Duration) -> Option<&str> {
        self.toast
            .as_ref()
            .filter(|(_, until)| now < *until)
            .map(|(text, _)| text.as_str())
    }

    pub fn slash(&self) -> Option<(Vec<&'static app::Command>, usize)> {
        if self.screen != Screen::Session || self.slash_dismissed {
            return None;
        }
        let query = self.composer.strip_prefix('/')?;
        let commands = app::matching(query);
        let selected = self.slash_selected.min(commands.len().saturating_sub(1));
        Some((commands, selected))
    }

    fn open(&mut self, overlay: Overlay) {
        if matches!(overlay, Overlay::Help) {
            self.scroll.help = 0;
        }
        self.escape = None;
        if let Some(previous) = self.overlay.replace(overlay) {
            self.underlays.push(previous);
        }
    }

    fn close(&mut self) {
        self.overlay = self.underlays.pop();
        self.escape = None;
    }

    fn navigate(&mut self, screen: Screen) {
        self.screen = screen;
        self.overlay = None;
        self.underlays.clear();
        self.escape = None;
    }

    fn execute(&mut self, action: Action, now: Duration, confirmed: bool) -> Effect {
        match action {
            Action::Dag => {
                self.dag_drawer = Some(!self.dag_drawer.unwrap_or(self.scroll.dag_visible));
                self.dag_focus = self.dag_drawer == Some(true);
            }
            Action::Plan => {
                self.plan_drawer = Some(!self.plan_drawer.unwrap_or(self.scroll.plan_visible));
            }
            Action::Theme => {
                self.theme = self.theme.next();
                self.notify(format!("Theme: {}", self.theme.name()), now);
            }
            Action::Go(screen) => self.navigate(screen),
            Action::Mode(mode) => {
                if self.running {
                    self.notify("Mode changes apply after this turn", now);
                } else {
                    self.mode = mode;
                }
            }
            Action::Help => {
                if !matches!(self.overlay, Some(Overlay::Help)) {
                    self.open(Overlay::Help);
                }
            }
            Action::Quit | Action::NewSession => {
                if !confirmed && (self.running || !self.composer.is_empty() || self.creator.dirty) {
                    self.open(Overlay::Confirm(action));
                } else if action == Action::Quit {
                    return Effect::Quit;
                } else {
                    match Self::new(self.branch.clone(), self.scope.root()) {
                        Ok(mut state) => {
                            state.mode = self.mode;
                            state.theme = self.theme;
                            *self = state;
                            self.notify("New session", now);
                            return Effect::NewSession;
                        }
                        Err(error) => self.notify(error.to_string(), now),
                    }
                }
            }
            Action::ToggleOutput => {
                if self.screen == Screen::Session {
                    let index = match self.selected {
                        Some(Selection::Tool(i)) => Some(i),
                        _ => self.tools.len().checked_sub(1),
                    };
                    if let Some(i) = index {
                        if let Some(tool) = self.tools.get_mut(i) {
                            tool.expanded = !tool.expanded;
                            self.selected = Some(Selection::Tool(i));
                            self.selection_epoch += 1;
                            self.follow = false;
                            return Effect::None;
                        }
                    }
                }
                self.notify("Select a Session tool block first", now);
            }
            Action::Rewind => {
                if self.screen == Screen::Session {
                    return self.rewind();
                }
                self.notify("Rewind is available on Session", now);
            }
        }
        Effect::None
    }

    pub fn launch(&self) -> bool {
        self.screen == Screen::Session && self.tasks.is_empty()
    }

    pub fn workspace(&self) -> &Path {
        self.scope.root()
    }

    pub fn paste(&mut self, text: &str) {
        let text = clean(text);
        if let Some(Overlay::Palette { query, selected }) = &mut self.overlay {
            query.push_str(&text.replace(['\n', '\t'], " "));
            *selected = 0;
            return;
        }
        if self.overlay.is_some() {
            return;
        }
        match self.screen {
            Screen::Creator => self.creator.paste(&text),
            Screen::Session => self.composer.push_str(&text),
            Screen::Memory if self.inspect.filtering => {
                for c in text.replace(['\n', '\t'], " ").chars() {
                    self.inspect.key(
                        self.screen,
                        KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE),
                        &mut self.scroll,
                    );
                }
            }
            Screen::Plugins if self.plugins.filtering => {
                for c in text.replace(['\n', '\t'], " ").chars() {
                    let _ = self.plugins.key(
                        KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE),
                        &mut self.scroll,
                    );
                }
            }
            _ => {}
        }
    }

    pub fn key(&mut self, key: KeyEvent, now: Duration) -> Effect {
        self.tick(now);
        if key.code != KeyCode::Esc {
            self.escape = None;
        }
        if key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL) {
            return Effect::Quit;
        }
        if key.modifiers.contains(KeyModifiers::ALT)
            && matches!(key.code, KeyCode::Left | KeyCode::Right)
        {
            self.navigate(self.screen.adjacent(key.code == KeyCode::Right));
            return Effect::None;
        }
        if key.code == KeyCode::Char('k') && key.modifiers.contains(KeyModifiers::CONTROL) {
            if matches!(self.overlay, Some(Overlay::Palette { .. })) {
                self.close();
            } else {
                self.open(Overlay::Palette {
                    query: String::new(),
                    selected: 0,
                });
            }
            return Effect::None;
        }
        if key.code == KeyCode::F(1)
            || (key.code == KeyCode::Char('?')
                && self.composer.is_empty()
                && !(self.screen == Screen::Plugins && self.plugins.filtering)
                && !(self.screen == Screen::Memory && self.inspect.filtering)
                && self.screen != Screen::Creator
                && self.overlay.is_none())
        {
            if !matches!(self.overlay, Some(Overlay::Help)) {
                self.open(Overlay::Help);
            }
            return Effect::None;
        }
        if let Some(mut overlay) = self.overlay.take() {
            if key.code == KeyCode::Esc {
                self.close();
                return Effect::None;
            }
            let action = match &mut overlay {
                Overlay::Palette { query, selected } => {
                    let commands = app::matching(query);
                    match key.code {
                        KeyCode::Enter => commands.get(*selected).map(|command| command.action),
                        KeyCode::Down | KeyCode::Tab => {
                            *selected = (*selected + 1) % commands.len().max(1);
                            None
                        }
                        KeyCode::Up => {
                            *selected = selected.saturating_sub(1);
                            None
                        }
                        KeyCode::Backspace => {
                            query.pop();
                            *selected = 0;
                            None
                        }
                        KeyCode::Char(c)
                            if !key
                                .modifiers
                                .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
                        {
                            query.push(c);
                            *selected = 0;
                            None
                        }
                        _ => None,
                    }
                }
                Overlay::Help => {
                    match key.code {
                        KeyCode::PageDown => {
                            self.scroll.help = self
                                .scroll
                                .help
                                .saturating_add(self.scroll.help_page.max(1))
                                .min(self.scroll.help_max)
                        }
                        KeyCode::PageUp => {
                            self.scroll.help = self
                                .scroll
                                .help
                                .saturating_sub(self.scroll.help_page.max(1))
                        }
                        _ => {}
                    }
                    None
                }
                Overlay::Publish { typed } => {
                    match key.code {
                        KeyCode::Char(c)
                            if !key
                                .modifiers
                                .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                                && typed.len() < 32 =>
                        {
                            typed.push(c)
                        }
                        KeyCode::Backspace => {
                            typed.pop();
                        }
                        KeyCode::Enter if typed == "y" => {
                            let effect = self
                                .creator
                                .request(self.mode, super::creator::Operation::Publish);
                            if effect != Effect::None {
                                self.close();
                                return effect;
                            }
                        }
                        _ => {}
                    }
                    None
                }
                Overlay::Confirm(action) if key.code == KeyCode::Enter => {
                    return self.execute(*action, now, true);
                }
                _ => None,
            };
            if let Some(action) = action {
                self.close();
                return self.execute(action, now, false);
            }
            self.overlay = Some(overlay);
            return Effect::None;
        }
        if self.screen == Screen::Creator {
            if self.creator.step == super::creator::Step::Publish && key.code == KeyCode::Enter {
                if self
                    .creator
                    .request(self.mode, super::creator::Operation::Publish)
                    != Effect::None
                {
                    self.open(Overlay::Publish {
                        typed: String::new(),
                    });
                }
                return Effect::None;
            }
            return self.creator.key(key, self.mode, &mut self.scroll);
        }
        if self.screen == Screen::Session && key.modifiers.contains(KeyModifiers::CONTROL) {
            let action = match key.code {
                KeyCode::Char('g') => Some(Action::Dag),
                KeyCode::Char('p') => Some(Action::Plan),
                KeyCode::Char('o') => Some(Action::ToggleOutput),
                _ => None,
            };
            if let Some(action) = action {
                return self.execute(action, now, false);
            }
        }
        if self.screen == Screen::Plugins && self.plugins.filtering {
            return self.plugin_key(key, now);
        }
        if self.screen == Screen::Memory && self.inspect.filtering {
            self.inspect.key(self.screen, key, &mut self.scroll);
            return Effect::None;
        }
        if let Some((commands, selected)) = self.slash() {
            match key.code {
                KeyCode::Esc => {
                    self.slash_dismissed = true;
                    self.escape = None;
                    return Effect::None;
                }
                KeyCode::Down | KeyCode::Tab => {
                    self.slash_selected = (selected + 1) % commands.len().max(1);
                    return Effect::None;
                }
                KeyCode::Up => {
                    self.slash_selected = selected.saturating_sub(1);
                    return Effect::None;
                }
                _ => {}
            }
        }
        if self.screen == Screen::Session
            && self.composer.starts_with('/')
            && key.code == KeyCode::Enter
        {
            let query = self.composer.strip_prefix('/').unwrap_or("").trim();
            let command = if self.slash_dismissed {
                app::COMMANDS.iter().find(|c| c.id == query)
            } else {
                let commands = app::matching(query);
                commands
                    .get(self.slash_selected.min(commands.len().saturating_sub(1)))
                    .copied()
            };
            if let Some(command) = command {
                let action = command.action;
                self.composer.clear();
                self.slash_selected = 0;
                return self.execute(action, now, false);
            }
            self.notify(format!("Unknown command: {}", self.composer), now);
            return Effect::None;
        }
        if (self.composer.is_empty() || self.screen != Screen::Session) && key.modifiers.is_empty()
        {
            if let KeyCode::Char(c @ '1'..='6') = key.code {
                if let Some(screen) = Screen::ALL.get(c as usize - '1' as usize) {
                    self.navigate(*screen);
                }
                return Effect::None;
            }
        }
        if self.screen == Screen::Plugins && key.code != KeyCode::Char('q') {
            return self.plugin_key(key, now);
        }
        if self.screen != Screen::Session {
            if let Some(message) = self.inspect.key(self.screen, key, &mut self.scroll) {
                self.notify(message, now);
            }
            return if key.code == KeyCode::Char('q') && self.composer.is_empty() {
                Effect::Quit
            } else {
                Effect::None
            };
        }
        if matches!(key.code, KeyCode::Char(_) | KeyCode::Backspace) {
            self.slash_dismissed = false;
            self.slash_selected = 0;
        }
        self.session_key(key, now)
    }

    fn plugin_key(&mut self, key: KeyEvent, now: Duration) -> Effect {
        match self.plugins.key(key, &mut self.scroll) {
            Ok(Some(template)) => {
                if self.creator.busy {
                    self.notify(
                        "Wait for the Creator request before replacing its draft",
                        now,
                    );
                    return Effect::None;
                }
                self.creator.prefill(&template);
                self.navigate(Screen::Creator);
            }
            Err(error) => self.notify(error, now),
            _ => {}
        }
        Effect::None
    }

    fn session_key(&mut self, key: KeyEvent, now: Duration) -> Effect {
        match key.code {
            KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => Effect::Quit,
            KeyCode::Char('q') if self.composer.is_empty() => Effect::Quit,
            KeyCode::Esc => {
                if self.running {
                    self.running = false;
                    self.escape = Some(now);
                    if let Some(task) = self.active.as_ref().and_then(|id| self.tasks.get_mut(id)) {
                        task.phase = Phase::Interrupted;
                        task.ended = Some(now);
                    }
                    return Effect::Interrupt;
                }
                if self
                    .escape
                    .take()
                    .is_some_and(|at| now.saturating_sub(at) <= Duration::from_millis(500))
                {
                    return self.rewind();
                } else {
                    self.escape = Some(now);
                }
                Effect::None
            }
            KeyCode::Tab => {
                let mode = match self.mode {
                    Mode::Architect => Mode::Code,
                    Mode::Code => Mode::Ask,
                    Mode::Ask => Mode::Architect,
                };
                self.execute(Action::Mode(mode), now, false)
            }
            KeyCode::Up | KeyCode::Down => {
                let rows = self.selections();
                let index = self
                    .selected
                    .as_ref()
                    .and_then(|s| rows.iter().position(|r| r == s))
                    .unwrap_or(0);
                let next = if key.code == KeyCode::Up {
                    index.saturating_sub(1)
                } else {
                    (index + 1).min(rows.len().saturating_sub(1))
                };
                self.selected = rows.get(next).cloned();
                self.selection_epoch += 1;
                self.follow = false;
                self.scroll.drawer = 0;
                self.scroll.lane = 0;
                Effect::None
            }
            KeyCode::PageDown | KeyCode::PageUp => {
                if key
                    .modifiers
                    .intersects(KeyModifiers::SHIFT | KeyModifiers::ALT | KeyModifiers::CONTROL)
                {
                    let (scroll, page) = if key
                        .modifiers
                        .intersects(KeyModifiers::SHIFT | KeyModifiers::ALT)
                    {
                        (&mut self.scroll.plan, self.scroll.plan_page.max(1))
                    } else {
                        (&mut self.scroll.rules, self.scroll.rules_page.max(1))
                    };
                    *scroll = if key.code == KeyCode::PageDown {
                        scroll.saturating_add(page)
                    } else {
                        scroll.saturating_sub(page)
                    };
                    return Effect::None;
                }
                let expanded = self.scroll.plan_visible
                    && match self.selected {
                        Some(Selection::Tool(i)) => self.tools.get(i).is_some_and(|t| t.expanded),
                        _ => false,
                    };
                if !expanded {
                    if !self.dag_focus || !self.scroll.dag_visible {
                        let page = self.scroll.transcript_page.max(1);
                        self.scroll.transcript = if key.code == KeyCode::PageDown {
                            self.scroll
                                .transcript
                                .saturating_add(page)
                                .min(self.scroll.transcript_max)
                        } else {
                            self.scroll.transcript.saturating_sub(page)
                        };
                        self.follow = key.code == KeyCode::PageDown
                            && self.scroll.transcript >= self.scroll.transcript_max;
                        if self.follow {
                            self.unseen = false;
                        }
                        return Effect::None;
                    }
                    let page = self.scroll.lane_page.max(1);
                    self.scroll.lane = if key.code == KeyCode::PageDown {
                        self.scroll.lane.saturating_add(page)
                    } else {
                        self.scroll.lane.saturating_sub(page)
                    };
                    return Effect::None;
                }
                let page = self.scroll.drawer_page.max(1);
                if key.code == KeyCode::PageDown {
                    self.scroll.drawer = self.scroll.drawer.saturating_add(page);
                } else {
                    self.scroll.drawer = self.scroll.drawer.saturating_sub(page);
                }
                Effect::None
            }
            KeyCode::Char(' ') if self.composer.is_empty() && self.selected.is_some() => {
                match &self.selected {
                    Some(Selection::Layer(i)) => {
                        if !self.collapsed_layers.remove(i) {
                            self.collapsed_layers.insert(*i);
                        }
                    }
                    Some(Selection::Node(id)) => {
                        if !self.collapsed_nodes.remove(id) {
                            self.collapsed_nodes.insert(id.clone());
                        }
                    }
                    Some(Selection::Tool(i)) => {
                        if let Some(t) = self.tools.get_mut(*i) {
                            t.expanded = !t.expanded;
                        }
                    }
                    _ => {}
                }
                Effect::None
            }
            KeyCode::Enter if !self.composer.trim().is_empty() => {
                if self.running {
                    return Effect::Steer(self.composer.clone());
                }
                let text = std::mem::take(&mut self.composer);
                self.last_prompt.clone_from(&text);
                self.next_turn += 1;
                let id = format!("turn-{}", self.next_turn);
                let deps = self.active.iter().cloned().collect();
                self.tasks.insert(
                    id.clone(),
                    Task {
                        prompt: clean(&text),
                        node: Node {
                            id: id.clone(),
                            deps,
                            write_scope: self.scope.clone(),
                        },
                        title: clean(&text).lines().next().unwrap_or_default().into(),
                        model: self.model_chain.clone(),
                        phase: Phase::Running,
                        started: now,
                        ended: None,
                        tokens: 0,
                        text: String::new(),
                    },
                );
                if let Err(error) = self.rebuild() {
                    self.notice = error.to_string();
                    return Effect::None;
                }
                self.active = Some(id.clone());
                self.selected = Some(Selection::Node(id));
                self.running = true;
                self.follow = true;
                self.unseen = false;
                Effect::Submit {
                    text,
                    read_only: self.mode.read_only(),
                }
            }
            KeyCode::Backspace => {
                self.composer.pop();
                Effect::None
            }
            KeyCode::Char(c)
                if !key
                    .modifiers
                    .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
            {
                self.composer.push(c);
                Effect::None
            }
            _ => Effect::None,
        }
    }

    fn rewind(&mut self) -> Effect {
        let Some(id) = self.active.take() else {
            return Effect::None;
        };
        self.tasks.remove(&id);
        self.tools.retain(|t| t.node != id);
        self.notes.retain(|n| n.turn != self.next_turn);
        if let Err(error) = self.rebuild() {
            self.notice = error.to_string();
        }
        self.composer.clone_from(&self.last_prompt);
        self.running = false;
        self.selected = None;
        self.notice = "Rewound view · cancellation does not undo filesystem writes".into();
        Effect::Rewind
    }

    pub fn not_sent(&mut self, now: Duration) {
        self.running = false;
        self.notice.clear();
        self.notify("Offline demo: not sent · no provider contacted", now);
        if let Some(task) = self.active.as_ref().and_then(|id| self.tasks.get_mut(id)) {
            task.phase = Phase::NotSent;
            task.ended = Some(now);
        }
    }

    pub fn reject_turn(&mut self, code: &str, now: Duration) {
        self.running = false;
        if let Some(task) = self.active.as_ref().and_then(|id| self.tasks.get_mut(id)) {
            task.phase = if code == "SESSION_BUSY" {
                Phase::NotSent
            } else {
                Phase::Failed
            };
            task.ended = Some(now);
        }
    }

    pub fn event(&mut self, event: &Event, now: Duration) {
        if !self.follow
            && matches!(
                event,
                Event::StreamToken { .. } | Event::ToolStarted { .. } | Event::ToolFinished { .. }
            )
        {
            self.unseen = true;
        }
        match event {
            Event::StreamToken { text, .. } => {
                if let Some(task) = self.active.as_ref().and_then(|id| self.tasks.get_mut(id)) {
                    let text = clean(text);
                    if !text.is_empty() {
                        if !task.text.is_empty() {
                            task.text.push_str("\n\n");
                        }
                        task.text.push_str(&text);
                    }
                }
            }
            Event::ToolStarted {
                call_id,
                name,
                arguments,
                ..
            } => {
                if let Some(node) = &self.active {
                    self.tools.push(ToolBlock {
                        started: now,
                        ended: None,
                        node: node.clone(),
                        call_id: call_id.clone(),
                        name: clean(name),
                        arguments: clean(&arguments.to_string()),
                        output: String::new(),
                        ok: None,
                        expanded: false,
                    });
                }
            }
            Event::ToolFinished {
                call_id,
                ok,
                summary,
                ..
            } => {
                if let Some(tool) = self.tools.iter_mut().rev().find(|t| &t.call_id == call_id) {
                    tool.ok = Some(*ok);
                    tool.ended = Some(now);
                    tool.output = clean(summary);
                }
            }
            Event::ReflectionGenerated { summary, rules, .. } => {
                self.rules = rules.iter().map(|r| clean(r)).collect();
                self.notice = clean(summary);
            }
            Event::Memory { procedural, .. } => {
                self.rules = procedural.iter().map(|r| clean(r)).collect()
            }
            Event::Status {
                status, scratchpad, ..
            } => {
                self.notice = clean(status);
                if let Some(plan) = scratchpad {
                    self.plan = clean(plan);
                }
            }
            Event::Telemetry {
                model,
                context_tokens,
                context_window,
                tokens_used,
                scratchpad,
                ..
            } => {
                self.model_chain = clean(model);
                self.context = *context_tokens;
                self.context_window = *context_window;
                self.plan = clean(scratchpad);
                let delta = tokens_used.saturating_sub(self.total_tokens);
                self.total_tokens = *tokens_used;
                self.samples.push_back((now, delta));
                while self
                    .samples
                    .front()
                    .is_some_and(|(at, _)| now.saturating_sub(*at) > Duration::from_secs(5))
                {
                    self.samples.pop_front();
                }
                if let Some(task) = self.active.as_ref().and_then(|id| self.tasks.get_mut(id)) {
                    task.tokens = task.tokens.saturating_add(delta);
                    task.model = self.model_chain.clone();
                }
            }
            Event::SessionCompleted {
                reason, scratchpad, ..
            } => {
                self.running = false;
                if let Some(plan) = scratchpad {
                    self.plan = clean(plan);
                }
                if let Some(task) = self.active.as_ref().and_then(|id| self.tasks.get_mut(id)) {
                    task.ended = Some(now);
                    task.phase = if reason == "completed" {
                        Phase::Evidence(Status::PreparedNotObserved)
                    } else {
                        Phase::Failed
                    };
                }
                self.notice = format!(
                    "{} · completion is not verification evidence",
                    clean(reason)
                );
            }
            Event::Error { code, message } => {
                self.notice = format!("{}: {}", clean(code), clean(message))
            }
            _ => {}
        }
    }

    #[cfg(test)]
    pub fn sample() -> Result<Self, Error> {
        let mut state = Self::new(
            "feat/frontier".into(),
            Path::new(env!("CARGO_MANIFEST_DIR")),
        )?;
        state.plugins = super::plugins::Plugins::sample()?;
        state.creator = super::creator::Creator::sample();
        state.model_chain = "planner → coder → advisor".into();
        state.context = 42_000;
        state.context_window = 128_000;
        state.samples.push_back((Duration::ZERO, 0));
        state.samples.push_back((Duration::from_secs(1), 175));
        state.plan = "[✓] Inspect workspace\n[✓] Design lanes\n[✓] Add outlines\n[●] Wire execution\n[ ] Verify changes".into();
        state.rules = vec![
            "Read before editing.".into(),
            "Require concrete verification evidence.".into(),
        ];
        for (id, title, deps, phase) in [
            (
                "1",
                "Map repository",
                vec![],
                Phase::Evidence(Status::ObservedVerified),
            ),
            ("2", "Build lane view", vec![], Phase::Running),
            ("3", "Check provider policy", vec![], Phase::Failed),
            (
                "4",
                "↻ repair 1 · Reject unsafe tools",
                vec!["3"],
                Phase::Running,
            ),
            (
                "5",
                "Verify integration",
                vec!["1", "2", "4"],
                Phase::Evidence(Status::Planned),
            ),
        ] {
            state.tasks.insert(
                id.into(),
                Task {
                    prompt: title.into(),
                    node: Node {
                        id: id.into(),
                        deps: deps.into_iter().map(Into::into).collect(),
                        write_scope: state.scope.clone(),
                    },
                    title: title.into(),
                    model: "coder".into(),
                    phase,
                    started: Duration::ZERO,
                    ended: None,
                    tokens: 320,
                    text: String::new(),
                },
            );
        }
        state.tools.push(ToolBlock {
            started: Duration::ZERO,
            ended: Some(Duration::from_millis(400)),
            node: "2".into(),
            call_id: "sample".into(),
            name: "repo_map".into(),
            arguments: "{}".into(),
            output: (0..12)
                .map(|i| format!("output {i:02}"))
                .collect::<Vec<_>>()
                .join("\n"),
            ok: Some(true),
            expanded: false,
        });
        for (kind, text) in [
            (AdvisorKind::Aside, "Keep the lane view compact."),
            (AdvisorKind::Warning, "Pricing is unknown."),
            (AdvisorKind::Blocker, "Verify before claiming done."),
        ] {
            state.notes.push(AdvisorNote {
                kind,
                turn: 2,
                text: text.into(),
            });
        }
        state.next_turn = state
            .notes
            .iter()
            .map(|note| note.turn)
            .max()
            .unwrap_or_default();
        state.rebuild()?;
        Ok(state)
    }
}
