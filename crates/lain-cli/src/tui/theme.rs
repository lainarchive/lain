use ratatui::buffer::Buffer;
use ratatui::style::Color;

use super::state::Mode;

// Silver and ice on near-black, after the la.03 sleeve. One accent; no violet, no orange.
pub const BACKGROUND: Color = Color::Rgb(7, 8, 10);
pub const PANEL: Color = Color::Rgb(14, 16, 20);
pub const SELECT: Color = Color::Rgb(18, 22, 28);
pub const LINE: Color = Color::Rgb(32, 36, 42);
pub const TEXT: Color = Color::Rgb(230, 233, 237);
pub const MUTED: Color = Color::Rgb(141, 148, 158);
pub const FAINT: Color = Color::Rgb(77, 83, 93);
pub const ACCENT: Color = Color::Rgb(142, 203, 255);
pub const HI: Color = Color::Rgb(228, 245, 255);
pub const GREEN: Color = Color::Rgb(159, 227, 200);
pub const RED: Color = Color::Rgb(255, 122, 133);
pub const SPINNER: [char; 10] = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Theme {
    #[default]
    Wired,
    Mono,
}

impl Theme {
    pub fn name(self) -> &'static str {
        match self {
            Self::Wired => "wired",
            Self::Mono => "mono",
        }
    }
    pub fn next(self) -> Self {
        match self {
            Self::Wired => Self::Mono,
            Self::Mono => Self::Wired,
        }
    }

    // Jaden asked for still rules: the travelling glint read as noise.
    pub fn gradient(self, _column: u16, _width: u16) -> Color {
        self.resolve(LINE)
    }

    pub fn spinner(now: std::time::Duration) -> char {
        SPINNER
            .get((now.as_millis() / 80 % SPINNER.len() as u128) as usize)
            .copied()
            .unwrap_or('●')
    }

    pub fn mode(self, mode: Mode) -> Color {
        self.resolve(match mode {
            Mode::Architect => ACCENT,
            Mode::Code => HI,
            Mode::Ask => GREEN,
        })
    }

    fn resolve(self, color: Color) -> Color {
        if self == Self::Wired {
            return color;
        }
        match color {
            BACKGROUND | PANEL | SELECT => Color::Black,
            TEXT | HI => Color::White,
            MUTED | ACCENT | GREEN => Color::Gray,
            FAINT | LINE => Color::DarkGray,
            RED => Color::White,
            _ => color,
        }
    }

    pub fn apply(self, buffer: &mut Buffer) {
        if self == Self::Wired {
            return;
        }
        for cell in &mut buffer.content {
            cell.fg = self.resolve(cell.fg);
            cell.bg = self.resolve(cell.bg);
        }
    }
}
