use super::state::Mode;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Screen {
    Session,
    Plugins,
    Creator,
    Memory,
    Sessions,
    Models,
}

impl Screen {
    pub const ALL: [Self; 6] = [
        Self::Session,
        Self::Plugins,
        Self::Creator,
        Self::Memory,
        Self::Sessions,
        Self::Models,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Self::Session => "Session",
            Self::Plugins => "Plugins",
            Self::Creator => "Creator",
            Self::Memory => "Memory",
            Self::Sessions => "Sessions",
            Self::Models => "Models",
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Self::Session => "session",
            Self::Plugins => "plugins",
            Self::Creator => "creator",
            Self::Memory => "memory",
            Self::Sessions => "sessions",
            Self::Models => "models",
        }
    }

    pub fn adjacent(self, forward: bool) -> Self {
        let index = Self::ALL.iter().position(|s| *s == self).unwrap_or(0);
        Self::ALL
            .get((index + if forward { 1 } else { Self::ALL.len() - 1 }) % Self::ALL.len())
            .copied()
            .unwrap_or(Self::Session)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Go(Screen),
    Mode(Mode),
    NewSession,
    Help,
    Quit,
    ToggleOutput,
    Rewind,
}

pub struct Command {
    pub id: &'static str,
    pub title: &'static str,
    pub hint: &'static str,
    pub action: Action,
}

pub const COMMANDS: [Command; 14] = [
    Command {
        id: "session",
        title: "Go to Session",
        hint: "1",
        action: Action::Go(Screen::Session),
    },
    Command {
        id: "plugins",
        title: "Go to Plugins",
        hint: "2",
        action: Action::Go(Screen::Plugins),
    },
    Command {
        id: "creator",
        title: "Go to Creator",
        hint: "3",
        action: Action::Go(Screen::Creator),
    },
    Command {
        id: "memory",
        title: "Go to Memory",
        hint: "4",
        action: Action::Go(Screen::Memory),
    },
    Command {
        id: "sessions",
        title: "Go to Sessions",
        hint: "5",
        action: Action::Go(Screen::Sessions),
    },
    Command {
        id: "models",
        title: "Go to Models",
        hint: "6",
        action: Action::Go(Screen::Models),
    },
    Command {
        id: "architect",
        title: "Mode Architect",
        hint: "Tab",
        action: Action::Mode(Mode::Architect),
    },
    Command {
        id: "code",
        title: "Mode Code",
        hint: "Tab",
        action: Action::Mode(Mode::Code),
    },
    Command {
        id: "ask",
        title: "Mode Ask",
        hint: "Tab",
        action: Action::Mode(Mode::Ask),
    },
    Command {
        id: "new",
        title: "New session",
        hint: "",
        action: Action::NewSession,
    },
    Command {
        id: "help",
        title: "Help",
        hint: "? / F1",
        action: Action::Help,
    },
    Command {
        id: "quit",
        title: "Quit",
        hint: "q / Ctrl-C",
        action: Action::Quit,
    },
    Command {
        id: "output",
        title: "Toggle tool output",
        hint: "Space",
        action: Action::ToggleOutput,
    },
    Command {
        id: "rewind",
        title: "Rewind turn",
        hint: "Esc Esc",
        action: Action::Rewind,
    },
];

#[derive(Debug)]
pub enum Overlay {
    Palette { query: String, selected: usize },
    Help,
    Confirm(Action),
}

pub const GLOBAL_KEYS: &[(&str, &str)] = &[
    (
        "1–6 / Alt+←→",
        "Screens (digits when not composing; Alt always)",
    ),
    (
        "Ctrl+K",
        "Commands; type to filter, ↑↓/Tab select, Enter run, Esc close",
    ),
    ("? / F1", "Help; Esc closes the topmost overlay"),
];

pub fn screen_keys(screen: Screen) -> &'static [(&'static str, &'static str)] {
    if screen == Screen::Session {
        &[
            (
                "Enter / Tab",
                "Send or attempt steer / cycle idle mode; / starts commands",
            ),
            ("↑↓ / Space", "Select / fold or expand (empty composer)"),
            ("PgUp/PgDn", "Lanes or selected expanded tool"),
            (
                "Alt-PgUp/PgDn / Ctrl-PgUp/PgDn",
                "Plan (Shift alias) / rules",
            ),
            (
                "Esc Esc / q / Ctrl-C",
                "Rewind / quit with empty composer / quit",
            ),
        ]
    } else if screen == Screen::Plugins {
        &[
            ("↑↓ / PgUp/PgDn", "Select entry / scroll detail"),
            ("r / /", "Refresh inventory and active tools / edit filter"),
            (
                "Enter / Esc",
                "Apply filter or open manifest template in Creator / clear filter",
            ),
        ]
    } else {
        &[("—", "Placeholder: screen actions arrive in a later phase")]
    }
}

pub fn score(query: &str, candidate: &str) -> Option<i64> {
    let query = query.to_lowercase();
    let candidate = candidate.to_lowercase();
    let mut chars = candidate.chars().enumerate();
    let mut previous = None;
    let mut score = 0;
    for ch in query.chars() {
        let (index, _) = chars.find(|(_, c)| *c == ch)?;
        score += 20 - index as i64;
        if previous.is_some_and(|p| p + 1 == index) {
            score += 20;
        }
        previous = Some(index);
    }
    if candidate.starts_with(&query) {
        score += 100;
    }
    if candidate == query {
        score += 100;
    }
    Some(score)
}

pub fn matching(query: &str) -> Vec<&'static Command> {
    let mut matches: Vec<_> = COMMANDS
        .iter()
        .filter_map(|command| {
            score(query, command.id)
                .max(score(query, command.title))
                .map(|rank| (rank, command))
        })
        .collect();
    matches.sort_by_key(|(rank, _)| std::cmp::Reverse(*rank));
    matches.into_iter().map(|(_, command)| command).collect()
}
