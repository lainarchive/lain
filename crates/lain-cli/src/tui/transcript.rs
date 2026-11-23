use std::time::Duration;

use lain_harness::advisor::AdvisorKind;
use ratatui::{
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::Paragraph,
    Frame,
};
use throbber_widgets_tui::{Throbber, ThrobberState};

use super::{
    launch_view::fit,
    state::{Scroll, Selection, State},
    theme::*,
};

const TIPS: [&str; 8] = [
    "Esc Esc rewinds the prompt; executed tools and writes are not undone.",
    "Ctrl+K finds screens, commands, and modes.",
    "/creator builds a tool; review its source and test before publishing.",
    "Ctrl+O expands the selected or last tool output.",
    "Alt+←/→ switches screens without losing your draft.",
    "PgUp reads earlier output; PgDn to the bottom follows again.",
    "Ctrl+G opens the DAG; Ctrl+P opens the plan and rules.",
    "/plugins shows tool permissions; scripts run unsandboxed as the host user.",
];

pub fn arguments(text: &str) -> String {
    fn value(v: &serde_json::Value) -> String {
        match v.as_str() {
            Some(text) if !text.is_empty() && !text.contains([',', '\n', '\r']) => text.to_owned(),
            _ => v.to_string(),
        }
    }
    let display = match serde_json::from_str::<serde_json::Value>(text) {
        Ok(serde_json::Value::Object(fields)) if fields.len() == 1 => {
            fields.values().next().map(value).unwrap_or_default()
        }
        Ok(serde_json::Value::Object(fields)) => fields
            .iter()
            .map(|(key, v)| format!("{key}={}", value(v)))
            .collect::<Vec<_>>()
            .join(", "),
        Ok(v) => value(&v),
        Err(_) => crate::render::clean(text)
            .lines()
            .collect::<Vec<_>>()
            .join(" "),
    };
    crate::render::clean(&display).replace(['\n', '\r', '\t'], " ")
}

pub fn spinner(now: Duration) -> String {
    let mut state = ThrobberState::default();
    state.calc_step(((now.as_millis() / 100) % 120) as i8);
    Throbber::default()
        .to_symbol_span(&state)
        .content
        .into_owned()
}

fn count(n: u64) -> String {
    if n >= 1000 {
        format!("{:.1}k", n as f64 / 1000.0)
    } else {
        n.to_string()
    }
}

pub fn inline(text: &str) -> Vec<Span<'static>> {
    let mut spans = vec![];
    let mut rest = text;
    while !rest.is_empty() {
        let marker = if rest.starts_with("**") {
            "**"
        } else if rest.starts_with('`') {
            "`"
        } else {
            ""
        };
        if !marker.is_empty() {
            if let Some((inside, tail)) =
                rest.strip_prefix(marker).and_then(|s| s.split_once(marker))
            {
                spans.push(Span::styled(
                    inside.to_owned(),
                    if marker == "**" {
                        Style::default().add_modifier(Modifier::BOLD)
                    } else {
                        Style::default().fg(ACCENT).bg(PANEL)
                    },
                ));
                rest = tail;
                continue;
            }
        }
        let next = rest
            .char_indices()
            .skip(1)
            .find(|(i, _)| {
                rest.get(*i..)
                    .is_some_and(|s| s.starts_with("**") || s.starts_with('`'))
            })
            .map_or(rest.len(), |(i, _)| i);
        if let Some(head) = rest.get(..next) {
            spans.push(Span::raw(head.to_owned()));
        }
        rest = rest.get(next..).unwrap_or("");
    }
    spans
}

fn code_lines(text: &str, width: usize) -> Vec<Line<'static>> {
    let mut chunks = vec![];
    let mut chunk = String::new();
    let mut used = 0;
    for c in text.chars() {
        let mut buf = [0; 4];
        let s: &str = c.encode_utf8(&mut buf);
        let n = Span::raw(s).width();
        if used + n > width {
            chunks.push(std::mem::take(&mut chunk));
            used = 0;
        }
        chunk.push(c);
        used += n;
    }
    chunks.push(chunk);
    chunks
        .into_iter()
        .map(|chunk| {
            let padding = width.saturating_sub(Line::raw(&chunk).width());
            Line::from(Span::styled(
                format!("│ {chunk}{} │", " ".repeat(padding)),
                Style::default().fg(MUTED).bg(PANEL),
            ))
        })
        .collect()
}

pub fn markdown(text: &str, width: u16) -> Vec<Line<'static>> {
    let width = usize::from(width.clamp(6, 88));
    let mut code = false;
    let mut lines = vec![];
    for line in text.lines() {
        if let Some(language) = line.trim_start().strip_prefix("```") {
            lines.push(Line::from(Span::styled(
                if code {
                    format!("╰{}╯", "─".repeat(width - 2))
                } else {
                    let title = format!("─ {} ", fit(language.trim(), width.saturating_sub(6)));
                    format!(
                        "╭{title}{}╮",
                        "─".repeat(width.saturating_sub(2 + Line::raw(&title).width()))
                    )
                },
                Style::default().fg(MUTED).bg(PANEL),
            )));
            code = !code;
        } else if code {
            lines.extend(code_lines(line, width - 4));
        } else if let Some(bullet) = line.strip_prefix("- ").or_else(|| line.strip_prefix("* ")) {
            let mut spans = vec![Span::styled("• ", Style::default().fg(ACCENT))];
            spans.extend(inline(bullet));
            lines.push(Line::from(spans));
        } else {
            lines.push(Line::from(inline(line)));
        }
    }
    lines
}

type Row = (Option<Selection>, Line<'static>);

fn rows(state: &State, width: u16, now: Duration) -> Vec<Row> {
    let mut rows = vec![];
    for (layer, nodes) in state.dag.layers().iter().enumerate() {
        let collapsed = state.collapsed_layers.contains(&layer);
        if collapsed || state.selected == Some(Selection::Layer(layer)) {
            rows.push((
                Some(Selection::Layer(layer)),
                Line::styled(
                    format!(
                        "{} layer {} · {} turns · Space {}",
                        if collapsed { "▸" } else { "▾" },
                        layer + 1,
                        nodes.len(),
                        if collapsed { "expands" } else { "folds" }
                    ),
                    Style::default().fg(MUTED),
                ),
            ));
        }
        if collapsed {
            continue;
        }
        for node in nodes {
            let Some(task) = state.tasks.get(&node.id) else {
                continue;
            };
            for (index, line) in task.prompt.lines().enumerate() {
                rows.push((
                    (index == 0).then(|| Selection::Node(node.id.clone())),
                    Line::styled(
                        format!("{} {line}", if index == 0 { "›" } else { " " }),
                        Style::default().bg(PANEL).add_modifier(Modifier::BOLD),
                    ),
                ));
            }
            if task.phase != super::state::Phase::Running {
                rows.push((
                    None,
                    Line::styled(
                        format!("  {} {}", task.phase.glyph(), task.phase.label()),
                        Style::default().fg(super::view::color(task.phase)),
                    ),
                ));
            }
            if state.collapsed_nodes.contains(&node.id) {
                continue;
            }
            let mut tools = 0;
            for (index, tool) in state
                .tools
                .iter()
                .enumerate()
                .filter(|(_, t)| t.node == node.id)
            {
                tools += 1;
                let running = tool.ok.is_none() && task.phase == super::state::Phase::Running;
                let status = match tool.ok {
                    Some(_) => "●".to_owned(),
                    None if running => spinner(now),
                    None => "○".to_owned(),
                };
                let color = match tool.ok {
                    Some(true) => GREEN,
                    Some(false) => RED,
                    None if running => ACCENT,
                    None => MUTED,
                };
                let elapsed = tool
                    .ended
                    .or(task.ended)
                    .unwrap_or(now)
                    .saturating_sub(tool.started)
                    .as_secs_f64();
                rows.push((
                    Some(Selection::Tool(index)),
                    Line::from(vec![
                        Span::styled("▎ ", Style::default().fg(ACCENT)),
                        Span::styled(status, Style::default().fg(color)),
                        Span::raw(format!(
                            " {}({})",
                            tool.name,
                            if tool.expanded {
                                arguments(&tool.arguments)
                            } else {
                                fit(
                                    &arguments(&tool.arguments),
                                    usize::from(width).saturating_sub(tool.name.len() + 14),
                                )
                            }
                        )),
                        Span::styled(format!("  {elapsed:.1}s"), Style::default().fg(MUTED)),
                    ]),
                ));
                for (index, line) in tool
                    .output
                    .lines()
                    .take(if tool.expanded { usize::MAX } else { 3 })
                    .enumerate()
                {
                    rows.push((
                        None,
                        Line::styled(
                            format!(
                                "▎  {} {}",
                                if index == 0 { "└" } else { " " },
                                if tool.expanded {
                                    line.to_owned()
                                } else {
                                    fit(line, usize::from(width.saturating_sub(5)))
                                }
                            ),
                            Style::default().fg(MUTED),
                        ),
                    ));
                }
                let hidden = tool.output.lines().count().saturating_sub(3);
                if hidden > 0 && !tool.expanded {
                    rows.push((
                        None,
                        Line::styled(
                            format!("▎    +{hidden} lines · ctrl+o expands"),
                            Style::default().fg(MUTED),
                        ),
                    ));
                }
            }
            if !task.text.is_empty() {
                rows.push((None, Line::raw("")));
                rows.push((
                    None,
                    Line::styled(
                        if task.model.is_empty() || task.model == "model unknown" {
                            "λ lain".into()
                        } else {
                            format!("λ lain · {}", task.model)
                        },
                        Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
                    ),
                ));
                rows.extend(
                    markdown(&task.text, width)
                        .into_iter()
                        .map(|line| (None, line)),
                );
            }
            let turn = node.id.trim_start_matches("turn-").parse::<u64>().ok();
            for note in state.notes.iter().filter(|note| Some(note.turn) == turn) {
                let (kind, color) = match note.kind {
                    AdvisorKind::Aside => ("aside", HI),
                    AdvisorKind::Warning => ("warning", HI),
                    AdvisorKind::Blocker => ("blocker", RED),
                };
                rows.push((
                    None,
                    Line::styled(
                        format!("◆ advisor · {kind}: {}", note.text),
                        Style::default().fg(color),
                    ),
                ));
            }
            rows.push((
                None,
                Line::styled(
                    format!(
                        "✱ {}s · {tools} tools · ↓{}",
                        task.ended
                            .unwrap_or(now)
                            .saturating_sub(task.started)
                            .as_secs(),
                        count(task.tokens)
                    ),
                    Style::default().fg(MUTED),
                ),
            ));
            rows.push((None, Line::raw("")));
        }
    }
    rows
}

fn wrapped(rows: Vec<Row>, width: u16) -> Vec<Row> {
    let width = usize::from(width).max(1);
    let mut result = vec![];
    for (mut selection, line) in rows {
        let style = line.style;
        let mut spans = vec![];
        let mut used = 0;
        for span in line.spans {
            let mut chunk = String::new();
            for c in span.content.chars() {
                let mut buf = [0; 4];
                let text: &str = c.encode_utf8(&mut buf);
                let n = Span::raw(text).width();
                if used + n > width {
                    spans.push(Span::styled(std::mem::take(&mut chunk), span.style));
                    result.push((
                        selection.take(),
                        Line::from(std::mem::take(&mut spans)).style(style),
                    ));
                    used = 0;
                }
                chunk.push(c);
                used += n;
            }
            if !chunk.is_empty() {
                spans.push(Span::styled(chunk, span.style));
            }
        }
        result.push((selection, Line::from(spans).style(style)));
    }
    result
}

pub fn draw(frame: &mut Frame, area: Rect, state: &State, now: Duration, scroll: &mut Scroll) {
    let rows = wrapped(rows(state, area.width, now), area.width);
    let height = usize::from(area.height.saturating_sub(1)).max(1);
    let max = rows.len().saturating_sub(height);
    let mut offset = if state.follow {
        max
    } else {
        state.scroll.transcript.min(max)
    };
    if state.selection_epoch != state.scroll.selection_epoch {
        if let Some(index) = rows.iter().position(|(selection, _)| {
            selection.is_some() && selection.as_ref() == state.selected.as_ref()
        }) {
            if index < offset {
                offset = index;
            } else if index >= offset + height {
                offset = index.saturating_sub(height - 1).min(max);
            }
        }
    }
    let lines = rows
        .into_iter()
        .skip(offset)
        .take(height)
        .map(|(selection, mut line)| {
            if selection.is_some() && selection == state.selected {
                line = line.style(Style::default().bg(PANEL).add_modifier(Modifier::BOLD));
            }
            if line.style.bg.is_some() {
                line.spans.push(Span::raw(
                    " ".repeat(usize::from(area.width).saturating_sub(line.width())),
                ));
            }
            line
        })
        .collect::<Vec<_>>();
    frame.render_widget(Paragraph::new(lines), area);
    if !state.follow && state.unseen {
        frame.render_widget(
            Paragraph::new(" ↓ new output · PgDn to follow ")
                .style(Style::default().bg(PANEL).fg(ACCENT)),
            Rect::new(area.x, area.bottom().saturating_sub(1), area.width, 1),
        );
    }
    scroll.transcript = offset;
    scroll.transcript_max = max;
    scroll.transcript_page = height.saturating_sub(1).max(1);
    scroll.selection_epoch = state.selection_epoch;
}

pub fn working(frame: &mut Frame, area: Rect, state: &State, now: Duration) {
    let Some(task) = state.active.as_ref().and_then(|id| state.tasks.get(id)) else {
        return;
    };
    let tip = TIPS
        .get(((now.as_secs() / 8) as usize) % TIPS.len())
        .copied()
        .unwrap_or_default();
    let lines = vec![
        Line::styled(
            format!(
                "{} Working… ({}s · ↓{} tokens · esc to interrupt)",
                spinner(now),
                now.saturating_sub(task.started).as_secs(),
                count(task.tokens)
            ),
            Style::default().fg(ACCENT),
        ),
        Line::styled(format!("└ Tip: {tip}"), Style::default().fg(MUTED)),
    ];
    frame.render_widget(Paragraph::new(lines), area);
}
