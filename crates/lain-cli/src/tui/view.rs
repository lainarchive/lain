use std::time::Duration;

use lain_harness::{advisor::AdvisorKind, evidence::Status};
use ratatui::{
    layout::{Constraint, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span, Text},
    widgets::{Block, Borders, Paragraph, Wrap},
    Frame,
};

use super::{
    state::{Mode, Phase, Selection, State},
    theme::*,
};

fn color(phase: Phase) -> Color {
    match phase {
        Phase::Running => BLUE,
        Phase::Failed => RED,
        Phase::Evidence(Status::ObservedVerified) => GREEN,
        _ => MUTED,
    }
}

fn panel(title: &str) -> Block<'_> {
    Block::default()
        .title(Span::styled(title, Style::default().fg(CYAN)))
        .borders(Borders::ALL)
        .border_style(Style::default().fg(MUTED))
        .style(Style::default().bg(PANEL).fg(TEXT))
}

fn count(n: usize) -> String {
    if n >= 1000 {
        format!("{}k", n / 1000)
    } else {
        n.to_string()
    }
}

fn banner(frame: &mut Frame, area: Rect, state: &State, now: Duration) {
    let cost = state
        .cost
        .filter(|cost| cost.is_finite() && *cost >= 0.0)
        .map_or_else(|| "cost unknown".into(), |cost| format!("cost ${cost:.4}"));
    let context = if state.context_window == 0 || state.context == 0 {
        "ctx unknown".into()
    } else {
        let percent = (state.context as f64 / state.context_window as f64 * 100.0).round() as usize;
        let filled = (percent.min(100) / 10).min(10);
        format!(
            "ctx [{}{}] {percent}% {}/{}",
            "━".repeat(filled),
            "─".repeat(10 - filled),
            count(state.context),
            count(state.context_window)
        )
    };
    let text = vec![
        Line::from(vec![
            Span::styled(
                format!(" {}", state.model_chain),
                Style::default().fg(VIOLET).add_modifier(Modifier::BOLD),
            ),
            Span::styled(format!("  ·  {}", state.branch), Style::default().fg(MUTED)),
        ]),
        Line::from(vec![
            Span::styled(
                format!(" {:.1} tok/s / 5s", state.velocity(now)),
                Style::default().fg(BLUE),
            ),
            Span::raw(format!("  ·  {cost}  ·  ")),
            Span::styled(context, Style::default().fg(CYAN)),
        ]),
    ];
    frame.render_widget(Paragraph::new(text).block(panel(" Lain · frontier ")), area);
}

fn lane_rows(state: &State, width: u16, now: Duration) -> Vec<(Option<Selection>, Line<'static>)> {
    let mut rows = vec![];
    for (layer, nodes) in state.dag.layers().iter().enumerate() {
        let collapsed = state.collapsed_layers.contains(&layer);
        let done = nodes
            .iter()
            .filter(|n| {
                state
                    .tasks
                    .get(&n.id)
                    .is_some_and(|t| t.phase == Phase::Evidence(Status::ObservedVerified))
            })
            .count();
        rows.push((
            Some(Selection::Layer(layer)),
            Line::styled(
                format!(
                    "{} layer {} · {} nodes · {} done",
                    if collapsed { "▸" } else { "▾" },
                    layer + 1,
                    nodes.len(),
                    done
                ),
                Style::default().fg(CYAN),
            ),
        ));
        if collapsed {
            continue;
        }
        for node in nodes {
            let Some(task) = state.tasks.get(&node.id) else {
                continue;
            };
            let collapsed = state.collapsed_nodes.contains(&node.id);
            let left = format!(
                "  {} {} {}",
                if collapsed { "▸" } else { "▾" },
                task.phase.glyph(),
                task.title
            );
            let elapsed = task
                .ended
                .unwrap_or(now)
                .saturating_sub(task.started)
                .as_secs();
            let right = format!(
                "{} · {} {}s · ↓{}",
                task.model,
                task.phase.label(),
                elapsed,
                task.tokens
            );
            let room = usize::from(width).saturating_sub(Line::from(right.clone()).width() + 1);
            let mut title = String::new();
            for c in left.chars() {
                if Line::from(format!("{title}{c}")).width() > room {
                    break;
                }
                title.push(c);
            }
            let padding = usize::from(width).saturating_sub(
                Line::from(title.clone()).width() + Line::from(right.clone()).width(),
            );
            rows.push((
                Some(Selection::Node(node.id.clone())),
                Line::from(vec![
                    Span::styled(
                        title,
                        Style::default()
                            .fg(if task.title.starts_with('↻') {
                                VIOLET
                            } else {
                                color(task.phase)
                            })
                            .add_modifier(Modifier::BOLD),
                    ),
                    Span::raw(" ".repeat(padding)),
                    Span::styled(right, Style::default().fg(MUTED)),
                ]),
            ));
            if collapsed {
                continue;
            }
            for (index, tool) in state
                .tools
                .iter()
                .enumerate()
                .filter(|(_, t)| t.node == node.id)
            {
                let tool_color = if tool.name.contains("file") || tool.name == "repo_map" {
                    PEACH
                } else {
                    AMBER
                };
                rows.push((
                    Some(Selection::Tool(index)),
                    Line::from(vec![
                        Span::raw(format!("    {} › ", if tool.expanded { "▾" } else { "▸" })),
                        Span::styled(tool.name.clone(), Style::default().fg(tool_color)),
                        Span::styled(format!("({})", tool.arguments), Style::default().fg(MUTED)),
                        Span::styled(
                            match tool.ok {
                                Some(true) => " ✓",
                                Some(false) => " ×",
                                None => " ●",
                            },
                            Style::default().fg(match tool.ok {
                                Some(true) => GREEN,
                                Some(false) => RED,
                                None => BLUE,
                            }),
                        ),
                    ]),
                ));
                for line in tool.output.lines().take(10) {
                    rows.push((
                        None,
                        Line::styled(format!("      {line}"), Style::default().fg(MUTED)),
                    ));
                }
                let remaining = tool.output.lines().count().saturating_sub(10);
                if remaining > 0 {
                    rows.push((
                        None,
                        Line::styled(
                            format!("      … {remaining} more lines"),
                            Style::default().fg(MUTED),
                        ),
                    ));
                }
            }
            for line in task.text.lines() {
                rows.push((None, Line::raw(format!("    {line}"))));
            }
            let turn = node.id.trim_start_matches("turn-").parse::<u64>().ok();
            for note in state.notes.iter().filter(|n| Some(n.turn) == turn) {
                let (kind, color) = match note.kind {
                    AdvisorKind::Aside => ("aside", VIOLET),
                    AdvisorKind::Warning => ("warning", AMBER),
                    AdvisorKind::Blocker => ("blocker", RED),
                };
                rows.push((
                    None,
                    Line::styled(
                        format!("    {kind} · {}", note.text),
                        Style::default().fg(color),
                    ),
                ));
            }
        }
        rows.push((None, Line::raw("")));
    }
    rows
}

fn lanes(frame: &mut Frame, area: Rect, state: &State, now: Duration) {
    let block = panel(" Execution DAG ");
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let mut rows = lane_rows(state, inner.width, now);
    if rows.is_empty() {
        rows.push((
            None,
            Line::styled("No turns yet · Enter to submit", Style::default().fg(MUTED)),
        ));
    }
    let selected = rows.iter().position(|(selection, _)| {
        selection.is_some() && selection.as_ref() == state.selected.as_ref()
    });
    let offset = selected
        .map_or(0, |i| {
            i.saturating_sub(usize::from(inner.height).saturating_sub(2))
        })
        .saturating_add(state.lane_scroll)
        .min(rows.len().saturating_sub(usize::from(inner.height)));
    let lines: Vec<Line<'_>> = rows
        .into_iter()
        .enumerate()
        .skip(offset)
        .map(|(i, (_, line))| {
            if Some(i) == selected {
                line.style(Style::default().bg(BACKGROUND).add_modifier(Modifier::BOLD))
            } else {
                line
            }
        })
        .collect();
    frame.render_widget(Paragraph::new(lines), inner);
}

fn drawer(frame: &mut Frame, area: Rect, state: &State) -> u16 {
    let tool = match state.selected {
        Some(Selection::Tool(i)) => state.tools.get(i).filter(|t| t.expanded),
        _ => None,
    };
    let sections = Layout::vertical(if tool.is_some() {
        vec![
            Constraint::Length(10),
            Constraint::Length(7),
            Constraint::Min(3),
        ]
    } else {
        vec![Constraint::Percentage(55), Constraint::Percentage(45)]
    })
    .split(area);
    let plan_lines: Vec<&str> = state.plan.lines().collect();
    let done = plan_lines
        .iter()
        .filter(|l| l.contains("[✓]") || l.contains("[x]"))
        .count();
    let mut plan = vec![Line::styled(
        format!("[Plan] {done}/{}", plan_lines.len()),
        Style::default().fg(CYAN).add_modifier(Modifier::BOLD),
    )];
    if plan_lines.is_empty() {
        plan.push(Line::styled(
            "No scratchpad yet",
            Style::default().fg(MUTED),
        ));
    }
    for line in plan_lines {
        let color = if line.contains("[●]") {
            GREEN
        } else if line.contains("[✓]") || line.contains("[x]") {
            MUTED
        } else {
            TEXT
        };
        plan.push(Line::styled(line, Style::default().fg(color)));
    }
    if let Some(rect) = sections.first() {
        let plan = Paragraph::new(plan).wrap(Wrap { trim: false });
        let title = if plan.line_count(rect.width.saturating_sub(2))
            > usize::from(rect.height.saturating_sub(2))
        {
            " Scratchpad … more below "
        } else {
            " Scratchpad "
        };
        frame.render_widget(plan.block(panel(title)), *rect);
    }
    let rules = if state.rules.is_empty() {
        "No procedural rules recalled".into()
    } else {
        state
            .rules
            .iter()
            .map(|r| format!("· {r}"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    if let Some(rect) = sections.get(1) {
        let rules = Paragraph::new(rules).wrap(Wrap { trim: false });
        let title = if rules.line_count(rect.width.saturating_sub(2))
            > usize::from(rect.height.saturating_sub(2))
        {
            " Procedural rules … more below "
        } else {
            " Procedural rules "
        };
        frame.render_widget(rules.block(panel(title)), *rect);
    }
    if let (Some(tool), Some(rect)) = (tool, sections.get(2)) {
        let output = Paragraph::new(tool.output.as_str()).wrap(Wrap { trim: false });
        let max = output
            .line_count(rect.width.saturating_sub(2))
            .saturating_sub(usize::from(rect.height.saturating_sub(2)));
        let scroll = usize::from(state.drawer_scroll)
            .min(max)
            .min(usize::from(u16::MAX)) as u16;
        frame.render_widget(
            output
                .scroll((scroll, 0))
                .block(panel(" Full output · PgUp/PgDn ")),
            *rect,
        );
        return scroll;
    }
    0
}

pub fn draw(frame: &mut Frame, state: &State, now: Duration) -> u16 {
    frame.render_widget(
        Block::default().style(Style::default().bg(BACKGROUND).fg(TEXT)),
        frame.area(),
    );
    let vertical = Layout::vertical([
        Constraint::Length(4),
        Constraint::Min(3),
        Constraint::Length(3),
        Constraint::Length(2),
    ])
    .split(frame.area());
    let Some(banner_area) = vertical.first() else {
        return 0;
    };
    let mut drawer_scroll = 0;
    banner(frame, *banner_area, state, now);
    if let Some(area) = vertical.get(1) {
        let main = Layout::horizontal([Constraint::Percentage(68), Constraint::Percentage(32)])
            .split(*area);
        if let Some(area) = main.first() {
            lanes(frame, *area, state, now);
        }
        if let Some(area) = main.get(1) {
            drawer_scroll = drawer(frame, *area, state);
        }
    }
    if let Some(area) = vertical.get(2) {
        let input = format!("› {}", state.composer);
        let width = Line::from(input.clone()).width();
        let scroll = width
            .saturating_sub(usize::from(area.width.saturating_sub(3)))
            .min(usize::from(u16::MAX)) as u16;
        frame.render_widget(
            Paragraph::new(input)
                .scroll((0, scroll))
                .block(panel(if state.running {
                    " Steer (daemon may reject busy) "
                } else {
                    " Compose "
                })),
            *area,
        );
        if area.width > 3 && area.height > 2 {
            frame.set_cursor_position((
                area.x + 1 + (width.saturating_sub(usize::from(scroll)) as u16).min(area.width - 3),
                area.y + 1,
            ));
        }
    }
    if let Some(area) = vertical.get(3) {
        let mut modes = vec![];
        for (i, mode) in [Mode::Architect, Mode::Code, Mode::Ask].iter().enumerate() {
            if i > 0 {
                modes.push(Span::styled(" | ", Style::default().fg(MUTED)));
            }
            modes.push(Span::styled(
                mode.name(),
                if *mode == state.mode {
                    Style::default()
                        .fg(BACKGROUND)
                        .bg(CYAN)
                        .add_modifier(Modifier::BOLD)
                } else {
                    Style::default().fg(MUTED)
                },
            ));
        }
        modes.push(Span::styled(
            " · Tab mode · Enter send · ↑↓ select · Space fold · Esc Esc rewind · q/Ctrl-C quit",
            Style::default().fg(MUTED),
        ));
        frame.render_widget(
            Paragraph::new(Text::from(vec![
                Line::from(modes),
                Line::styled(state.notice.as_str(), Style::default().fg(AMBER)),
            ])),
            *area,
        );
    }
    drawer_scroll
}
