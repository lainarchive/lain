use ratatui::{layout::Alignment, text::Line, widgets::Cell};

pub fn number(value: u64) -> String {
    for (scale, suffix) in [
        (1e18, "E"),
        (1e15, "P"),
        (1e12, "T"),
        (1e9, "G"),
        (1e6, "M"),
        (1e3, "k"),
    ] {
        if value as f64 >= scale * 0.99995 {
            return format!("{:.1}{suffix}", value as f64 / scale);
        }
    }
    value.to_string()
}

pub fn money(value: Option<f64>) -> String {
    value
        .filter(|n| n.is_finite() && *n >= 0.0)
        .map_or_else(|| "—".into(), |n| format!("~${n:.2}"))
}

pub fn age(seconds: u64) -> String {
    match seconds {
        0 => "just now".into(),
        1..=59 => format!("{seconds}s ago"),
        60..=3599 => format!("{}m ago", seconds / 60),
        3600..=86399 => format!("{}h ago", seconds / 3600),
        _ => format!("{}d ago", seconds / 86400),
    }
}

pub fn numeric(value: impl Into<String>) -> Cell<'static> {
    Cell::from(Line::from(value.into()).alignment(Alignment::Right))
}
