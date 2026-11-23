use std::{borrow::Cow, time::Duration};

use lain_harness::{advisor::AdvisorKind, evidence::Status};
use ratatui::{
    layout::{Constraint, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph, Wrap},
    Frame,
};

use super::{
    app::Screen,
    plugins, shell_view,
    state::{Phase, Scroll, Selection, State},
    theme::*,
};

pub(super) fn color(phase: Phase) -> Color {
    match phase {
        Phase::Running => ACCENT,
        Phase::Failed => RED,
        Phase::Evidence(Status::ObservedVerified) => GREEN,
        _ => MUTED,
    }
}

fn panel<'a>(title: impl Into<Cow<'a, str>>) -> Block<'a> {
    Block::default()
        .title(Span::styled(
            title,
            Style::default().fg(MUTED).add_modifier(Modifier::BOLD),
        ))
        .borders(Borders::ALL)
        // Open panels: one left rule, same box geometry the scroll maths assumes.
        .border_set(ratatui::symbols::border::Set {
            top_left: " ",
            top_right: " ",
            bottom_left: " ",
            bottom_right: " ",
            vertical_left: "│",
            vertical_right: " ",
            horizontal_top: " ",
            horizontal_bottom: " ",
        })
        .border_style(Style::default().fg(LINE))
        .style(Style::default().bg(PANEL).fg(TEXT))
}

fn has_banner(state: &State, now: Duration) -> bool {
    let notice = state.toast_text(now).unwrap_or(&state.notice);
    state.velocity(now) > 0.0
        || state.cost.is_some_and(|c| c.is_finite() && c >= 0.0)
        || (!notice.is_empty() && !notice.starts_with("Ready") && notice != "New session")
}

fn banner(frame: &mut Frame, area: Rect, state: &State, now: Duration) {
    let cost = state
        .cost
        .filter(|cost| cost.is_finite() && *cost >= 0.0)
        .map(|cost| format!("cost ${cost:.4}"));
    let mut telemetry = vec![];
    if let Some(rate) = state.token_rate(now).filter(|rate| *rate > 0.0) {
        telemetry.push(format!(
            "{} {rate:.1} tok/s",
            sparkline(&state.rate_history(now, 16))
        ));
    }
    if let Some(cost) = cost {
        telemetry.push(cost);
    }
    let telemetry = telemetry.join(" · ");
    let notice_width = usize::from(area.width).saturating_sub(telemetry.len() + 3);
    let notice =
        super::launch_view::fit(state.toast_text(now).unwrap_or(&state.notice), notice_width);
    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(
                format!("{notice:<notice_width$}   "),
                Style::default().fg(MUTED),
            ),
            Span::styled(telemetry, Style::default().fg(MUTED)),
        ])),
        area,
    );
}

fn lane_rows(state: &State, width: u16, now: Duration) -> Vec<(Option<Selection>, Line<'static>)> {
    let mut rows = vec![];
    let has_lanes = state.tasks.values().any(|t| t.prompt.is_empty());
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
        let label = format!(
            "{} LAYER {}  {done}/{} ",
            if collapsed { "▸" } else { "▾" },
            layer + 1,
            nodes.len()
        );
        let rule = "─".repeat(usize::from(width).saturating_sub(Line::raw(&label).width()));
        rows.push((
            Some(Selection::Layer(layer)),
            Line::from(vec![
                Span::styled(
                    label,
                    Style::default().fg(MUTED).add_modifier(Modifier::BOLD),
                ),
                Span::styled(rule, Style::default().fg(LINE)),
            ]),
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
                if task.phase == Phase::Running {
                    Theme::spinner(now).to_string()
                } else {
                    task.phase.glyph().to_string()
                },
                task.title
            );
            let elapsed = task
                .ended
                .unwrap_or(now)
                .saturating_sub(task.started)
                .as_secs();
            let right = format!(
                "{}  {}  {}s  ↓{}",
                task.model,
                task.phase.label(),
                elapsed,
                super::launch_view::count(usize::try_from(task.tokens).unwrap_or(usize::MAX))
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
                                HI
                            } else {
                                color(task.phase)
                            })
                            .add_modifier(Modifier::BOLD),
                    ),
                    Span::raw(" ".repeat(padding)),
                    Span::styled(right, Style::default().fg(MUTED)),
                ]),
            ));
            // With planner lanes running, the chat turn's detail already lives in the transcript.
            if collapsed || (has_lanes && !task.prompt.is_empty()) {
                continue;
            }
            for (index, tool) in state
                .tools
                .iter()
                .enumerate()
                .filter(|(_, t)| t.node == node.id)
            {
                let tool_color = if tool.name.contains("file") || tool.name == "repo_map" {
                    MUTED
                } else {
                    HI
                };
                rows.push((
                    Some(Selection::Tool(index)),
                    Line::from(vec![
                        Span::raw(format!("    {} › ", if tool.expanded { "▾" } else { "▸" })),
                        Span::styled(tool.name.clone(), Style::default().fg(tool_color)),
                        Span::styled(
                            format!("({})", super::transcript::arguments(&tool.arguments)),
                            Style::default().fg(MUTED),
                        ),
                        Span::styled(
                            match tool.ok {
                                Some(true) => " ✓",
                                Some(false) => " ×",
                                None => " ●",
                            },
                            Style::default().fg(match tool.ok {
                                Some(true) => GREEN,
                                Some(false) => RED,
                                None => ACCENT,
                            }),
                        ),
                        Span::styled(
                            match tool.output.lines().count() {
                                1 => format!("  {}", tool.output.trim()),
                                _ => String::new(),
                            },
                            Style::default().fg(MUTED),
                        ),
                    ]),
                ));
                // A one-line result already sits on the tool row.
                for line in tool
                    .output
                    .lines()
                    .take(10)
                    .filter(|_| tool.output.lines().count() > 1)
                {
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
                    AdvisorKind::Aside => ("aside", HI),
                    AdvisorKind::Warning => ("warning", ACCENT),
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

type Row = (Option<Selection>, Line<'static>);

fn sparkline(values: &[u64]) -> String {
    const BARS: [char; 8] = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
    let max = values.iter().copied().max().unwrap_or(0).max(1);
    values
        .iter()
        .map(|v| BARS.get((v * 7 / max) as usize).copied().unwrap_or('▁'))
        .collect()
}

/// Segmented bar, one segment per lane, then the evidence counts.
fn run_header(state: &State, width: u16) -> Vec<Row> {
    let phases: Vec<Phase> = state
        .dag
        .layers()
        .iter()
        .flatten()
        .filter_map(|n| state.tasks.get(&n.id).map(|t| t.phase))
        .collect();
    if phases.is_empty() {
        return vec![];
    }
    let total = phases.len();
    let verified = phases
        .iter()
        .filter(|p| **p == Phase::Evidence(Status::ObservedVerified))
        .count();
    let running = phases.iter().filter(|p| **p == Phase::Running).count();
    let failed = phases.iter().filter(|p| **p == Phase::Failed).count();
    let segment = (usize::from(width) / total).clamp(1, 10);
    let bar = phases
        .iter()
        .map(|p| {
            let fg = match p {
                Phase::Evidence(Status::ObservedVerified) => GREEN,
                Phase::Running => ACCENT,
                Phase::Failed => RED,
                _ => LINE,
            };
            Span::styled(
                "▄".repeat(segment.saturating_sub(1)) + " ",
                Style::default().fg(fg),
            )
        })
        .collect::<Vec<_>>();
    vec![
        (None, Line::from(bar)),
        (
            None,
            Line::from(vec![
                Span::styled(
                    format!("{verified}/{total} verified"),
                    Style::default().fg(GREEN),
                ),
                Span::styled(format!("   {running} running"), Style::default().fg(ACCENT)),
                Span::styled(
                    format!("   {failed} failed"),
                    Style::default().fg(if failed > 0 { RED } else { FAINT }),
                ),
            ]),
        ),
        (None, Line::raw("")),
    ]
}

/// One bar per lane on a shared clock, so overlap and stragglers show at a glance.
fn timeline(state: &State, width: u16, now: Duration) -> Vec<Row> {
    let tasks: Vec<_> = state
        .dag
        .layers()
        .iter()
        .flatten()
        .filter_map(|n| state.tasks.get(&n.id))
        .collect();
    let Some(start) = tasks.iter().map(|t| t.started).min() else {
        return vec![];
    };
    let label = tasks
        .iter()
        .map(|t| Line::raw(&t.title).width())
        .max()
        .unwrap_or(0)
        .min(16);
    let track = usize::from(width).saturating_sub(label + 2);
    if track < 8 {
        return vec![];
    }
    let span = now.saturating_sub(start).as_secs_f64().max(1.0);
    let col = |at: Duration| {
        ((at.saturating_sub(start).as_secs_f64() / span) * (track - 1) as f64).round() as usize
    };
    let mut rows = vec![(
        None,
        Line::from(vec![
            Span::styled(
                "TIMELINE",
                Style::default().fg(MUTED).add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                format!(
                    "{:>w$}",
                    format!("{}s ▼", span.round()),
                    w = usize::from(width) - 8
                ),
                Style::default().fg(FAINT),
            ),
        ]),
    )];
    for task in tasks {
        let from = col(task.started).min(track - 1);
        let to = if matches!(
            task.phase,
            Phase::Evidence(Status::Planned) | Phase::NotSent
        ) {
            from
        } else {
            col(task.ended.unwrap_or(now)).clamp(from, track - 1)
        };
        let fg = color(task.phase);
        let name: String = task.title.chars().take(label).collect();
        let mut spans = vec![
            Span::styled(format!("{name:<label$}  "), Style::default().fg(MUTED)),
            Span::styled("·".repeat(from), Style::default().fg(LINE)),
            Span::styled("━".repeat(to - from), Style::default().fg(fg)),
        ];
        let head = match task.phase {
            Phase::Running => Span::styled("▸", Style::default().fg(HI)),
            Phase::Evidence(Status::ObservedVerified) => {
                Span::styled("✓", Style::default().fg(GREEN))
            }
            Phase::Failed => Span::styled("✕", Style::default().fg(RED)),
            _ => Span::styled("·", Style::default().fg(LINE)),
        };
        spans.push(head);
        spans.push(Span::styled(
            "·".repeat(track.saturating_sub(to + 1)),
            Style::default().fg(LINE),
        ));
        rows.push((None, Line::from(spans)));
    }
    rows
}

fn page_height(area: Rect) -> u16 {
    area.height.saturating_sub(3).max(1)
}

fn lanes(frame: &mut Frame, area: Rect, state: &State, now: Duration) -> (usize, usize) {
    let block = panel(" Execution DAG ");
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let mut rows = lane_rows(state, inner.width, now);
    if !rows.is_empty() {
        let mut top = run_header(state, inner.width);
        top.append(&mut rows);
        rows = top;
        rows.extend(timeline(state, inner.width, now));
    }
    if rows.is_empty() {
        rows.push((
            None,
            Line::styled("No turns yet · Enter to submit", Style::default().fg(MUTED)),
        ));
    }
    let selected = rows.iter().position(|(selection, _)| {
        selection.is_some() && selection.as_ref() == state.selected.as_ref()
    });
    let max = rows.len().saturating_sub(usize::from(inner.height));
    let base = selected
        .map_or(0, |i| {
            i.saturating_sub(usize::from(inner.height).saturating_sub(2))
        })
        .min(max);
    let scroll = state.scroll.lane.min(max.saturating_sub(base));
    let offset = base + scroll;
    let lines: Vec<Line<'_>> = rows
        .into_iter()
        .enumerate()
        .skip(offset)
        .map(|(i, (_, line))| {
            if Some(i) == selected {
                line.style(Style::default().bg(SELECT).add_modifier(Modifier::BOLD))
            } else {
                line
            }
        })
        .collect();
    frame.render_widget(Paragraph::new(lines), inner);
    (scroll, usize::from(page_height(area)))
}

fn scroll_panel(
    frame: &mut Frame,
    area: Rect,
    content: Paragraph<'_>,
    title: &str,
    requested: u16,
) -> (u16, u16) {
    let max = content
        .line_count(area.width.saturating_sub(2))
        .saturating_sub(usize::from(area.height.saturating_sub(2)));
    let scroll = usize::from(requested).min(max).min(usize::from(u16::MAX)) as u16;
    let title = format!(
        " {title}{}{} ",
        if scroll > 0 { " ↑" } else { "" },
        if usize::from(scroll) < max {
            " … more below"
        } else {
            ""
        }
    );
    frame.render_widget(content.scroll((scroll, 0)).block(panel(title)), area);
    (scroll, page_height(area))
}

fn drawer(frame: &mut Frame, area: Rect, state: &State) -> Scroll {
    let mut scroll = Scroll {
        drawer: 0,
        ..state.scroll
    };
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
        Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
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
        (scroll.plan, scroll.plan_page) =
            scroll_panel(frame, *rect, plan, "Scratchpad", state.scroll.plan);
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
        (scroll.rules, scroll.rules_page) =
            scroll_panel(frame, *rect, rules, "Procedural rules", state.scroll.rules);
    }
    if let (Some(tool), Some(rect)) = (tool, sections.get(2)) {
        let output = Paragraph::new(tool.output.as_str()).wrap(Wrap { trim: false });
        let max = output
            .line_count(rect.width.saturating_sub(2))
            .saturating_sub(usize::from(rect.height.saturating_sub(2)));
        let offset = usize::from(state.scroll.drawer)
            .min(max)
            .min(usize::from(u16::MAX)) as u16;
        frame.render_widget(
            output
                .scroll((offset, 0))
                .block(panel(" Full output · PgUp/PgDn ")),
            *rect,
        );
        scroll.drawer = offset;
        scroll.drawer_page = page_height(*rect);
    }
    scroll
}

pub fn has_room(area: Rect, state: &State) -> bool {
    let (width, height) = if state.launch() { (80, 24) } else { (120, 30) };
    area.width >= width && area.height >= height
}

fn composer_rows(text: &str, width: u16) -> Vec<String> {
    let input = format!("› {}", text.replace('\t', "    ").replace('\n', "\n  "));
    let mut rows = Vec::new();
    for line in input.split('\n') {
        let mut row = String::new();
        let mut used = 0;
        for glyph in Span::raw(line).styled_graphemes(Style::default()) {
            let n = Line::raw(glyph.symbol).width();
            if used + n > usize::from(width.max(1)) && !row.is_empty() {
                rows.push(std::mem::take(&mut row));
                used = 0;
            }
            row.push_str(glyph.symbol);
            used += n;
        }
        rows.push(row);
    }
    rows
}

pub fn draw(frame: &mut Frame, state: &State, now: Duration) -> Scroll {
    frame.render_widget(
        Block::default().style(Style::default().bg(BACKGROUND).fg(TEXT)),
        frame.area(),
    );
    if !has_room(frame.area(), state) {
        let size = if state.launch() { "80x24" } else { "120x30" };
        frame.render_widget(
            Paragraph::new(format!(
                "terminal too small (need {size})\nResize to continue · Ctrl-C quits"
            ))
            .wrap(Wrap { trim: false }),
            frame.area(),
        );
        state.theme.apply(frame.buffer_mut());
        return Scroll::default();
    }
    let draft = composer_rows(&state.composer, frame.area().width.saturating_sub(1));
    let vertical = Layout::vertical([
        Constraint::Length(1),
        Constraint::Length(u16::from(has_banner(state, now))),
        Constraint::Min(3),
        Constraint::Length(if state.screen == Screen::Session {
            draft.len().clamp(1, 6) as u16 + 2
        } else {
            1
        }),
        Constraint::Length(1),
    ])
    .split(frame.area());
    let Some(banner_area) = vertical.first() else {
        return Scroll::default();
    };
    let mut scroll = state.scroll;
    shell_view::tabs(frame, *banner_area, state);
    if let Some(area) = vertical.get(1) {
        banner(frame, *area, state, now);
    }
    if let Some(area) = vertical.get(2) {
        if state.screen == Screen::Session {
            let completion_height = state
                .slash()
                .map(|(commands, _)| (commands.len().clamp(1, 4) + 2) as u16)
                .unwrap_or(0);
            let parts = Layout::vertical([
                Constraint::Min(3),
                Constraint::Length(completion_height),
                Constraint::Length(if state.running { 2 } else { 0 }),
            ])
            .split(*area);
            let area = parts.first().unwrap_or(area);
            if completion_height > 0 {
                if let Some(completion) = parts.get(1) {
                    shell_view::completion(frame, *completion, state);
                }
            }
            if state.running {
                if let Some(working) = parts.get(2) {
                    super::transcript::working(frame, *working, state, now);
                }
            }
            if state.launch() {
                super::launch_view::draw(frame, *area, state);
            } else {
                let dag = state.dag_drawer.unwrap_or(frame.area().width >= 160);
                let plan = state.plan_drawer.unwrap_or(frame.area().width >= 160);
                let main = Layout::horizontal([
                    Constraint::Min(40),
                    Constraint::Length(if dag || plan {
                        (area.width / 3).clamp(40, 64)
                    } else {
                        0
                    }),
                ])
                .split(*area);
                if let Some(right) = main.get(1) {
                    let sections = Layout::vertical([
                        Constraint::Percentage(if dag {
                            if plan {
                                // The full-output drawer needs the room back when a tool is open.
                                if matches!(state.selected, Some(Selection::Tool(i)) if state.tools.get(i).is_some_and(|t| t.expanded)) {
                                    40
                                } else {
                                    70
                                }
                            } else {
                                100
                            }
                        } else {
                            0
                        }),
                        Constraint::Min(0),
                    ])
                    .split(*right);
                    if plan {
                        if let Some(area) = sections.get(1) {
                            scroll = drawer(frame, *area, state);
                        }
                    }
                    if dag {
                        if let Some(area) = sections.first() {
                            (scroll.lane, scroll.lane_page) = lanes(frame, *area, state, now);
                        }
                    }
                }
                scroll.dag_visible = dag;
                scroll.plan_visible = plan;
                if let Some(area) = main.first() {
                    super::transcript::draw(frame, *area, state, now, &mut scroll);
                }
            }
        } else if state.screen == Screen::Plugins {
            plugins::draw(frame, *area, &state.plugins, &mut scroll);
        } else if state.screen == Screen::Creator {
            super::creator_view::draw(frame, *area, state, &mut scroll);
        } else {
            match state.screen {
                Screen::Bots => super::bots::draw(frame, *area, &state.inspect, now),
                Screen::Sessions => super::inspect::sessions(frame, *area, &state.inspect, now),
                Screen::Memory => {
                    super::inspect::memory(frame, *area, &state.inspect, now, &mut scroll)
                }
                Screen::Models => super::inspect::models(frame, *area, state, now),
                _ => {}
            }
        }
    }
    if let Some(area) = vertical.get(3).filter(|_| state.screen == Screen::Session) {
        let visible = usize::from(area.height.saturating_sub(2));
        scroll.composer_max = draft.len().saturating_sub(visible);
        scroll.composer = scroll.composer.min(scroll.composer_max);
        let start = scroll.composer_max.saturating_sub(scroll.composer);
        let input = draft
            .iter()
            .skip(start)
            .take(visible)
            .cloned()
            .map(Line::from)
            .collect::<Vec<_>>();
        frame.render_widget(
            Paragraph::new(input)
                .style(Style::default().fg(if state.composer.is_empty() {
                    MUTED
                } else {
                    TEXT
                }))
                .block(
                    Block::default()
                        .borders(Borders::TOP | Borders::BOTTOM)
                        .border_style(Style::default().fg(MUTED))
                        .title_bottom(
                            Line::from(if draft.len()>1 {" ↑/↓ scroll draft · Enter submit · Ctrl+K commands · F1 help "}
                            else if state.launch() {" Tab mode · Ctrl+K commands · F1 help "}
                            else if state.plan_drawer.unwrap_or(state.scroll.plan_visible) {
                                " Alt-PgUp/PgDn plan · Shift alias · Ctrl-PgUp/PgDn rules · Ctrl+G DAG · Ctrl+P close · Ctrl+K commands · F1 help "
                            } else {" Tab mode · Ctrl+O output · Ctrl+G DAG · Ctrl+P plan/rules · Ctrl+K commands · F1 help "})
                                .alignment(ratatui::layout::Alignment::Right),
                        ),
                ),
            *area,
        );
        if state.composer.is_empty() {
            frame.render_widget(
                Paragraph::new("› Ask Lain anything").style(Style::default().fg(MUTED)),
                Rect::new(area.x, area.y + 1, area.width, 1),
            );
        }
        super::launch_view::rule(frame, Rect::new(area.x, area.y, area.width, 1), state.theme);
        if area.width > 3 && area.height > 2 && state.overlay.is_none() && scroll.composer == 0 {
            frame.set_cursor_position((
                area.x
                    + draft
                        .last()
                        .map_or(0, |line| Line::raw(line).width())
                        .min(usize::from(area.width - 1)) as u16,
                area.y
                    + 1
                    + draft
                        .len()
                        .saturating_sub(start + 1)
                        .min(visible.saturating_sub(1)) as u16,
            ));
        }
    }
    if let Some(area) = vertical.get(4) {
        super::launch_view::footer(frame, *area, state);
    }
    if !matches!(state.screen, Screen::Session | Screen::Bots) {
        if let Some(area) = vertical.get(3) {
            frame.render_widget(
                Paragraph::new(match state.screen {
                    Screen::Sessions => "↑↓ select · Enter attach status · r refresh · Ctrl+K commands · F1 help",
                    Screen::Memory => "↑↓ select · / filter · PgUp/PgDn detail · r refresh · Ctrl+K commands · F1 help",
                    Screen::Models => "r reload local config · Ctrl+K commands · F1 help · Alt+←/→ screens",
                    _=>"Ctrl+K commands · F1 help · Alt+←/→ screens",
                })
                    .style(Style::default().fg(MUTED)),
                *area,
            );
        }
    }
    shell_view::overlay(frame, state, &mut scroll);
    state.theme.apply(frame.buffer_mut());
    scroll
}
