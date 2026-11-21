use crossterm::style::{Color, Stylize};

pub const SPINNER: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

pub fn clean(text: &str) -> String {
    text.chars()
        .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
        .collect()
}

pub fn badge(name: &str, outcome: Option<bool>, color: bool) -> String {
    let (label, shade) = match outcome {
        None => ("[ RUN ]", Color::Yellow),
        Some(true) => ("[ OK ]", Color::Green),
        Some(false) => ("[FAIL]", Color::Red),
    };
    let name = clean(name).replace(['\n', '\t'], " ");
    if color {
        format!("{} {name}", label.with(shade))
    } else {
        format!("{label} {name}")
    }
}

fn clip(text: &str, width: usize) -> String {
    // I reserve two cells per non-ASCII character; a wide glyph must not push the border past the terminal edge.
    let mut used = 0;
    text.chars()
        .take_while(|c| {
            used += if c.is_ascii() { 1 } else { 2 };
            used <= width
        })
        .collect()
}

pub fn render_scratchpad_box(text: &str, width: usize) -> Vec<String> {
    let width = width.clamp(4, 100);
    let inner = width - 4;
    let mut lines = vec![format!("+{}+", "-".repeat(width - 2))];
    let row = |text: &str| {
        let text = clip(text, inner);
        let used: usize = text.chars().map(|c| if c.is_ascii() { 1 } else { 2 }).sum();
        format!("| {text}{} |", " ".repeat(inner.saturating_sub(used)))
    };
    lines.push(row("Scratchpad"));
    let text = clean(text).replace('\t', " ");
    if text.trim().is_empty() {
        lines.push(row("(empty)"));
    } else {
        for line in text.lines().take(6) {
            lines.push(row(line));
        }
        if text.lines().count() > 6 {
            lines.push(row("..."));
        }
    }
    lines.push(format!("+{}+", "-".repeat(width - 2)));
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_badges_and_escape_filtering() {
        assert_eq!(badge("tool", None, false), "[ RUN ] tool");
        assert_eq!(badge("tool", Some(true), false), "[ OK ] tool");
        assert_eq!(badge("tool", Some(false), false), "[FAIL] tool");
        assert!(badge("tool", Some(true), true).contains('\u{1b}'));
        assert!(!clean("\u{1b}[2Jhello\r").contains('\u{1b}'));
    }

    #[test]
    fn scratchpad_empty_narrow_wide_and_truncated() {
        for width in [0, 4, 10, 80, 1000] {
            for text in [
                "",
                "hello",
                "a very long line that should be clipped",
                "界界界界",
                "1\n2\n3\n4\n5\n6\n7",
            ] {
                let lines = render_scratchpad_box(text, width);
                assert!(lines.len() >= 3);
                assert!(lines
                    .iter()
                    .all(|line| line.chars().count() <= width.clamp(4, 100)));
                assert!(lines.first().is_some_and(|line| line.starts_with('+')));
                assert!(lines.last().is_some_and(|line| line.starts_with('+')));
            }
        }
        assert!(render_scratchpad_box("1\n2\n3\n4\n5\n6\n7", 80)
            .iter()
            .any(|line| line.contains("...")));
    }
}
