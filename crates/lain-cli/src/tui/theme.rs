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

    /// Colour of one cell of a full-width rule: brushed silver, with a glint that
    /// sweeps across once every `width + 30` ticks.
    pub fn gradient(self, column: u16, width: u16, tick: u64) -> Color {
        if self == Self::Mono {
            return Color::Gray;
        }
        let span = u64::from(width) + 30;
        let head = (tick * 9 % span) as i64 - 15;
        match (i64::from(column) - head).abs() {
            0..=1 => HI,
            2..=3 => Color::Rgb(180, 198, 216),
            4..=5 => Color::Rgb(108, 122, 138),
            6..=7 => Color::Rgb(57, 66, 77),
            _ => LINE,
        }
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
