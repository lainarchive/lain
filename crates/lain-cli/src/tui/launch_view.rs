use std::collections::BTreeMap;

use lain_ipc::ToolSource;
use ratatui::{
    layout::{Alignment, Constraint, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph},
    Frame,
};

use super::{state::State, theme::*};
use crate::render::clean;

pub fn fit(text: &str, width: usize) -> String {
    if Line::raw(text).width() <= width {
        return text.into();
    }
    let mut result = String::new();
    let mut used = 0;
    for c in text.chars() {
        let n = Span::raw(c.to_string()).width();
        if used + n >= width {
            break;
        }
        result.push(c);
        used += n;
    }
    if width > 0 {
        result.push('…');
    }
    result
}

pub fn rule(frame: &mut Frame, area: Rect, theme: Theme) {
    frame.render_widget(
        Paragraph::new(Line::from(
            (0..area.width)
                .map(|x| Span::styled("─", Style::default().fg(theme.gradient(x, area.width))))
                .collect::<Vec<_>>(),
        )),
        area,
    );
}

fn card(title: &str) -> Block<'_> {
    Block::default()
        .borders(Borders::ALL)
        .title(title)
        .border_style(Style::default().fg(MUTED))
}

pub fn draw(frame: &mut Frame, area: Rect, state: &State) {
    let width = area.width.saturating_sub(4).min(120);
    let content = Rect::new(
        area.x + (area.width - width) / 2,
        area.y + 1,
        width,
        area.height.saturating_sub(2),
    );
    let sections = Layout::vertical([
        Constraint::Length(8),
        Constraint::Length(3),
        Constraint::Length(if width >= 92 { 7 } else { 2 }),
        Constraint::Min(0),
    ])
    .split(content);
    if let Some(area) = sections.first() {
        wordmark(frame, *area, state.theme);
    }
    if let Some(area) = sections.get(1) {
        let cwd = clean(&state.workspace().display().to_string());
        let prefix = format!("λ lain v{} · ", env!("CARGO_PKG_VERSION"));
        let branch = format!(" · {}", clean(&state.branch));
        let path_width = usize::from(area.width)
            .saturating_sub(Line::raw(&prefix).width() + Line::raw(&branch).width());
        frame.render_widget(
            Paragraph::new(format!("{prefix}{}{branch}", fit(&cwd, path_width)))
                .style(Style::default().fg(MUTED)),
            *area,
        );
    }
    if let Some(area) = sections.get(2) {
        if width >= 92 {
            let columns = Layout::horizontal([
                Constraint::Percentage(50),
                Constraint::Length(2),
                Constraint::Percentage(50),
            ])
            .split(*area);
            if let Some(area) = columns.first() {
                frame.render_widget(
                    Paragraph::new(vec![
                        Line::styled(
                            if state.model_chain.is_empty() || state.model_chain == "model unknown"
                            {
                                state.mode.name().into()
                            } else {
                                format!("{} · {}", state.model_chain, state.mode.name())
                            },
                            Style::default().fg(ACCENT),
                        ),
                        Line::from(format!(
                            "session {}",
                            state.session_id.as_deref().unwrap_or("not connected")
                        )),
                        Line::styled("Last session unknown", Style::default().fg(MUTED)),
                    ])
                    .block(card(" session ")),
                    *area,
                );
            }
            if let Some(area) = columns.get(2) {
                frame.render_widget(
                    Paragraph::new(vec![
                        Line::from(vec![
                            Span::styled("/creator", Style::default().fg(ACCENT)),
                            Span::raw("   build a tool"),
                        ]),
                        Line::from(vec![
                            Span::styled("/plugins", Style::default().fg(ACCENT)),
                            Span::raw("   browse tools"),
                        ]),
                        Line::from(vec![
                            Span::styled("/theme", Style::default().fg(ACCENT)),
                            Span::raw("     switch look"),
                        ]),
                        Line::from(vec![
                            Span::styled("?", Style::default().fg(ACCENT)),
                            Span::raw("          every shortcut"),
                        ]),
                    ])
                    .block(card(" get started ")),
                    *area,
                );
            }
        } else {
            frame.render_widget(
                Paragraph::new("/creator build · /plugins tools · /theme look · ? help")
                    .style(Style::default().fg(ACCENT)),
                *area,
            );
        }
    }
    if width >= 116 {
        if let Some(area) = sections.get(3).filter(|area| area.height >= 4) {
            grid(frame, *area, state);
        }
    }
}

fn wordmark(frame: &mut Frame, area: Rect, theme: Theme) {
    let glyphs = [
        [
            "1000000", "1000000", "1000000", "1000000", "1000000", "1000000", "1111111",
        ],
        [
            "0011100", "0100010", "1000001", "1000001", "1111111", "1000001", "1000001",
        ],
        [
            "1111111", "0001000", "0001000", "0001000", "0001000", "0001000", "1111111",
        ],
        [
            "1000001", "1100001", "1010001", "1001001", "1000101", "1000011", "1000001",
        ],
    ];
    let mut pixels = vec![];
    for y in 0..7 {
        let text = glyphs
            .iter()
            .filter_map(|glyph| glyph.get(y))
            .map(|row| {
                row.chars()
                    .map(|c| if c == '1' { "██" } else { "  " })
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("  ");
        pixels.push(text);
    }
    let width = pixels.first().map_or(0, |row| Line::raw(row).width()) as u16;
    let origin = area.x + area.width.saturating_sub(width + 1) / 2;
    for shadow in [true, false] {
        for (y, row) in pixels.iter().enumerate() {
            for (x, c) in row.chars().enumerate().filter(|(_, c)| *c != ' ') {
                let dx = u16::from(shadow);
                let point = (origin + x as u16 + dx, area.y + y as u16 + dx);
                if area.contains(point.into()) {
                    if let Some(cell) = frame.buffer_mut().cell_mut(point) {
                        cell.set_symbol(&c.to_string())
                            .set_style(Style::default().fg(if shadow {
                                LINE
                            } else {
                                theme.gradient(x as u16, width)
                            }));
                    }
                }
            }
        }
    }
}

fn grid(frame: &mut Frame, area: Rect, state: &State) {
    let mut groups: BTreeMap<(bool, String), Vec<String>> = BTreeMap::new();
    for tool in &state.plugins.tools {
        let group = match &tool.source {
            ToolSource::Plugin { manifest_name, .. } => {
                (true, format!("plugin {}", clean(manifest_name)))
            }
            ToolSource::Builtin => (
                false,
                format!(
                    "builtin / {}",
                    match tool.name.as_str() {
                        "bash" | "powershell" | "coding_session" => "execution",
                        "create_tool" | "test_tool" => "creator",
                        name if name.to_ascii_lowercase().contains("memory")
                            || name == "UpdateScratchpad" =>
                            "memory",
                        "repo_map" => "workspace",
                        _ => "other",
                    }
                ),
            ),
        };
        groups.entry(group).or_default().push(clean(&tool.name));
    }
    let area = Rect {
        height: area.height.min(
            groups
                .len()
                .max(1)
                .saturating_add(2)
                .min(usize::from(u16::MAX)) as u16,
        ),
        ..area
    };
    let inner = card("").inner(area);
    let columns = (usize::from(inner.width.saturating_sub(24)) / 24).max(1);
    let cell_width = usize::from(inner.width.saturating_sub(24)) / columns;
    let max_rows = usize::from(inner.height);
    let visible = if groups.len() > max_rows {
        max_rows.saturating_sub(1)
    } else {
        max_rows
    };
    let mut lines = vec![];
    let mut remaining = 0;
    for (index, ((plugin, label), mut names)) in groups.into_iter().enumerate() {
        if index >= visible {
            remaining += names.len();
            continue;
        }
        names.sort();
        let mut spans = vec![Span::styled(
            format!("{:<24}", fit(&label, 23)),
            Style::default().fg(if plugin { HI } else { ACCENT }),
        )];
        let shown = if names.len() > columns {
            columns.saturating_sub(1)
        } else {
            names.len()
        };
        for name in names.iter().take(shown) {
            let text = fit(name, cell_width.saturating_sub(2));
            let padding = cell_width.saturating_sub(Line::raw(&text).width());
            spans.push(Span::styled(
                format!("{text}{}", " ".repeat(padding)),
                Style::default().fg(TEXT),
            ));
        }
        if names.len() > shown {
            spans.push(Span::styled(
                format!("+{} more", names.len() - shown),
                Style::default().fg(MUTED),
            ));
        }
        lines.push(Line::from(spans));
    }
    if remaining > 0 {
        lines.push(Line::styled(
            format!("+{remaining} more · /plugins for full inventory"),
            Style::default().fg(MUTED),
        ));
    }
    if lines.is_empty() {
        lines.push(Line::styled(
            state
                .plugins
                .tools_error
                .clone()
                .unwrap_or_else(|| "No active tools reported yet · /plugins to inspect".into()),
            Style::default().fg(MUTED),
        ));
    }
    frame.render_widget(
        Paragraph::new(lines).block(
            card(&format!(" active tools · {} ", state.plugins.tools.len()))
                .title(Line::from(" /plugins to find tools ").alignment(Alignment::Right)),
        ),
        area,
    );
}

pub(super) fn count(n: usize) -> String {
    if n >= 1_000_000 {
        format!("{}M", n / 1_000_000)
    } else if n >= 1000 {
        format!("{}k", n / 1000)
    } else {
        n.to_string()
    }
}

pub fn footer(frame: &mut Frame, area: Rect, state: &State, now: std::time::Duration) {
    let mut right = if state.model_chain == "model unknown" {
        String::new()
    } else {
        state.model_chain.clone()
    };
    let rate = state
        .token_rate(now)
        .filter(|rate| *rate > 0.0)
        .map(|rate| {
            format!(
                "{} {rate:.1} tok/s",
                super::view::sparkline(&state.rate_history(now, 16))
            )
        });
    if state.context_window > 0 {
        let percent = (state.context as f64 / state.context_window as f64 * 100.0) as usize;
        let filled = (percent / 10).max(usize::from(state.context > 0)).min(10);
        let context = format!(
            "{}ctx {}{} {percent}% {}/{}",
            rate.as_ref().map(|r| format!("{r} · ")).unwrap_or_default(),
            "━".repeat(filled),
            "─".repeat(10 - filled),
            count(state.context),
            count(state.context_window)
        );
        if !right.is_empty() {
            right.push_str(" · ");
        }
        right.push_str(&context);
        // The left side is short, so the meter strip may take two thirds before the model goes.
        if Line::raw(&right).width() > usize::from(area.width) * 2 / 3 {
            right = context;
        }
    } else if let Some(rate) = rate {
        if !right.is_empty() {
            right.push_str(" · ");
        }
        right.push_str(&rate);
    }
    if state.reconnecting {
        right = "reconnecting…".into();
    }
    let right_width = Line::raw(&right)
        .width()
        .min(usize::from(area.width).saturating_sub(34));
    let sections = Layout::horizontal([Constraint::Min(1), Constraint::Length(right_width as u16)])
        .split(area);
    if let Some(area) = sections.first() {
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled(
                    format!("lain v{}  ", env!("CARGO_PKG_VERSION")),
                    Style::default().fg(TEXT),
                ),
                Span::styled(
                    format!(" {} ", state.mode.name()),
                    Style::default()
                        .fg(BACKGROUND)
                        .bg(state.theme.mode(state.mode))
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    format!(" branch:{}", clean(&state.branch)),
                    Style::default().fg(MUTED),
                ),
            ])),
            *area,
        );
    }
    if let Some(area) = sections.get(1) {
        frame.render_widget(
            Paragraph::new(fit(&right, right_width))
                .alignment(Alignment::Right)
                .style(Style::default().fg(MUTED)),
            *area,
        );
    }
}
