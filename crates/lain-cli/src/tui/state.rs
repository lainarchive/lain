use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    path::Path,
    time::Duration,
};

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use lain_harness::{
    advisor::{AdvisorKind, AdvisorNote},
    dag::{Dag, Node},
    evidence::Status,
    scope::WriteScope,
};
use lain_ipc::Event;

use crate::{render::clean, Error};

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
    None,
    Submit { text: String, read_only: bool },
    Steer(String),
    Rewind,
    Quit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Evidence(Status),
    Running,
    Failed,
}

impl Phase {
    pub fn glyph(self) -> &'static str {
        match self {
            Self::Running => "●",
            Self::Failed => "×",
            Self::Evidence(Status::ObservedVerified) => "✓",
            Self::Evidence(Status::PreparedNotObserved) => "◇",
            Self::Evidence(Status::Planned) => "○",
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Failed => "failed",
            Self::Evidence(Status::ObservedVerified) => "verified",
            Self::Evidence(Status::PreparedNotObserved) => "prepared",
            Self::Evidence(Status::Planned) => "waiting",
        }
    }
}

#[derive(Debug)]
pub struct Task {
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

pub struct State {
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
    pub drawer_scroll: u16,
    pub lane_scroll: usize,
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
            drawer_scroll: 0,
            lane_scroll: 0,
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

    pub fn velocity(&self, now: Duration) -> f64 {
        self.samples
            .iter()
            .filter(|(at, _)| now.saturating_sub(*at) <= Duration::from_secs(5))
            .map(|(_, count)| *count)
            .sum::<u64>() as f64
            / 5.0
    }

    pub fn key(&mut self, key: KeyEvent, now: Duration) -> Effect {
        if key.code != KeyCode::Esc {
            self.escape = None;
        }
        match key.code {
            KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => Effect::Quit,
            KeyCode::Char('q') => Effect::Quit,
            KeyCode::Esc => {
                if self
                    .escape
                    .take()
                    .is_some_and(|at| now.saturating_sub(at) <= Duration::from_millis(500))
                {
                    if let Some(id) = self.active.take() {
                        self.tasks.remove(&id);
                        self.tools.retain(|t| t.node != id);
                        self.notes.retain(|n| n.turn != self.next_turn);
                        if let Err(error) = self.rebuild() {
                            self.notice = error.to_string();
                        }
                        self.composer.clone_from(&self.last_prompt);
                        self.running = false;
                        self.selected = None;
                        self.notice =
                            "Rewound view · cancellation does not undo filesystem writes".into();
                        return Effect::Rewind;
                    }
                } else {
                    self.escape = Some(now);
                }
                Effect::None
            }
            KeyCode::Tab => {
                if self.running {
                    self.notice = "Mode changes apply after this turn".into();
                } else {
                    self.mode = match self.mode {
                        Mode::Architect => Mode::Code,
                        Mode::Code => Mode::Ask,
                        Mode::Ask => Mode::Architect,
                    };
                }
                Effect::None
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
                self.drawer_scroll = 0;
                self.lane_scroll = 0;
                Effect::None
            }
            KeyCode::PageDown | KeyCode::PageUp => {
                let expanded = match self.selected {
                    Some(Selection::Tool(i)) => self.tools.get(i).is_some_and(|t| t.expanded),
                    _ => false,
                };
                if !expanded {
                    self.lane_scroll = if key.code == KeyCode::PageDown {
                        self.lane_scroll.saturating_add(5)
                    } else {
                        self.lane_scroll.saturating_sub(5)
                    };
                    return Effect::None;
                }
                if key.code == KeyCode::PageDown {
                    self.drawer_scroll = self.drawer_scroll.saturating_add(5);
                } else {
                    self.drawer_scroll = self.drawer_scroll.saturating_sub(5);
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

    pub fn event(&mut self, event: &Event, now: Duration) {
        match event {
            Event::StreamToken { text, .. } => {
                if let Some(task) = self.active.as_ref().and_then(|id| self.tasks.get_mut(id)) {
                    task.text.push_str(&clean(text));
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

    pub fn sample() -> Result<Self, Error> {
        let mut state = Self::new(
            "feat/frontier".into(),
            Path::new(env!("CARGO_MANIFEST_DIR")),
        )?;
        state.model_chain = "planner → coder → advisor".into();
        state.context = 42_000;
        state.context_window = 128_000;
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
        state.rebuild()?;
        Ok(state)
    }
}
