use ratatui::buffer::Buffer;
use ratatui::style::Color;

use super::state::Mode;

pub const BACKGROUND: Color = Color::Rgb(10, 13, 20);
pub const PANEL: Color = Color::Rgb(17, 23, 34);
pub const TEXT: Color = Color::Rgb(218, 228, 239);
pub const MUTED: Color = Color::Rgb(136, 151, 174);
pub const CYAN: Color = Color::Rgb(159, 216, 250);
pub const BLUE: Color = Color::Rgb(132, 182, 230);
pub const GREEN: Color = Color::Rgb(143, 201, 179);
pub const RED: Color = Color::Rgb(239, 155, 152);
pub const VIOLET: Color = Color::Rgb(179, 160, 238);
pub const AMBER: Color = Color::Rgb(232, 163, 145);
pub const PEACH: Color = Color::Rgb(216, 170, 159);
pub const SHADOW: Color = Color::Rgb(43, 53, 76);

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

    pub fn gradient(self, column: u16, width: u16) -> Color {
        if self == Self::Mono {
            return Color::Gray;
        }
        let t = f32::from(column) / f32::from(width.saturating_sub(1).max(1));
        Color::Rgb(
            (159.0 + 20.0 * t) as u8,
            (216.0 - 56.0 * t) as u8,
            (250.0 - 12.0 * t) as u8,
        )
    }

    pub fn mode(self, mode: Mode) -> Color {
        self.resolve(match mode {
            Mode::Architect => VIOLET,
            Mode::Code => CYAN,
            Mode::Ask => GREEN,
        })
    }

    fn resolve(self, color: Color) -> Color {
        if self == Self::Wired {
            return color;
        }
        match color {
            BACKGROUND => Color::Black,
            PANEL => Color::Black,
            TEXT => Color::White,
            MUTED => Color::Gray,
            SHADOW => Color::DarkGray,
            RED | AMBER | PEACH => Color::White,
            CYAN | BLUE | GREEN | VIOLET => Color::Gray,
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
