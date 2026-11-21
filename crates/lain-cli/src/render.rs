use crossterm::style::{Color, Stylize};

pub const SPINNER: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

pub fn clean(text: &str) -> String {
    text.chars()
        .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
        .collect()
}

pub fn readable_status(text: &str) -> String {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return clean(text);
    };
    let Some(status) = value.get("status").and_then(serde_json::Value::as_str) else {
        return clean(text);
    };
    let mut label = status.replace('_', " ");
    if let Some(reason) = value.get("reason").and_then(serde_json::Value::as_str) {
        label.push_str(&format!(" ({})", reason.replace('_', " ")));
    }
    clean(&label)
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

fn char_width(c: char) -> usize {
    match c {
        '\u{0300}'..='\u{036f}'
        | '\u{1ab0}'..='\u{1aff}'
        | '\u{1dc0}'..='\u{1dff}'
        | '\u{200d}'
        | '\u{20d0}'..='\u{20ff}'
        | '\u{fe00}'..='\u{fe0f}'
        | '\u{fe20}'..='\u{fe2f}'
        | '\u{e0100}'..='\u{e01ef}' => 0,
        '\u{1100}'..='\u{115f}'
        | '\u{2329}'..='\u{232a}'
        | '\u{2600}'..='\u{27bf}'
        | '\u{2e80}'..='\u{a4cf}'
        | '\u{ac00}'..='\u{d7a3}'
        | '\u{f900}'..='\u{faff}'
        | '\u{fe10}'..='\u{fe19}'
        | '\u{fe30}'..='\u{fe6f}'
        | '\u{ff01}'..='\u{ff60}'
        | '\u{ffe0}'..='\u{ffe6}'
        | '\u{1f300}'..='\u{1faff}'
        | '\u{20000}'..='\u{3fffd}' => 2,
        _ => 1,
    }
}

fn clip(text: &str, width: usize) -> String {
    let mut used = 0;
    text.chars()
        .take_while(|c| {
            used += char_width(*c);
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
        let used: usize = text.chars().map(char_width).sum();
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
    fn scratchpad_display_width_alignment() {
        assert_eq!("café résumé".chars().map(char_width).sum::<usize>(), 11);
        assert_eq!("界界 wide row".chars().map(char_width).sum::<usize>(), 13);
        for c in ['界', '한', 'Ａ', '😀'] {
            assert_eq!(char_width(c), 2);
        }
        for width in [4, 5, 6, 9, 12, 15, 34] {
            for text in ["café résumé", "界界 wide row", "한글 Ａ😀", "cafe\u{301}"] {
                let lines = render_scratchpad_box(text, width);
                assert!(lines
                    .iter()
                    .all(|line| line.chars().map(char_width).sum::<usize>() == width));
            }
        }
        assert!(render_scratchpad_box("café résumé", 34)
            .iter()
            .any(|line| line.contains("café résumé")));
        assert_eq!(clip("界界", 3), "界");
        assert_eq!(clip("é", 1), "é");
    }

    #[test]
    fn statuses_are_readable() {
        for (input, expected) in [
            (
                r#"{"status":"terminated","reason":"cancelled"}"#,
                "terminated (cancelled)",
            ),
            (r#"{"status":"awaiting_input"}"#, "awaiting input"),
            (r#"{"status":"idle"}"#, "idle"),
            ("running", "running"),
            ("", ""),
            ("invalid JSON", "invalid JSON"),
        ] {
            assert_eq!(readable_status(input), expected);
        }
    }

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
