use std::time::Duration;

use lain_ipc::SessionStatus;
use ratatui::{
    layout::{Constraint, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Cell, Paragraph, Row, Table, TableState, Wrap},
    Frame,
};

use super::{
    formatting::{age, money, number, numeric},
    inspect::Inspect,
    theme::*,
};

fn panel(title: impl Into<String>) -> Block<'static> {
    Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(MUTED))
        .title(title.into())
}

fn status(value: Option<SessionStatus>) -> (&'static str, ratatui::style::Color) {
    match value {
        Some(SessionStatus::Running) => ("● running", GREEN),
        Some(SessionStatus::Idle) => ("○ idle", MUTED),
        Some(SessionStatus::Busy) => ("● busy", AMBER),
        None => ("— unknown", MUTED),
    }
}

pub fn draw(frame: &mut Frame, area: Rect, view: &Inspect, now: Duration) {
    let parts = Layout::vertical([
        Constraint::Length(10),
        Constraint::Length(1),
        Constraint::Min(5),
        Constraint::Length(1),
        Constraint::Length(1),
    ])
    .split(area);
    let Some(header) = parts.first() else {
        return;
    };
    let ready = view.daemon.state.ready();
    let mut identity = vec![
        Span::styled(
            if ready { "● " } else { "○ " },
            Style::default().fg(if ready { GREEN } else { MUTED }),
        ),
        Span::styled(
            "λ lain daemon",
            Style::default().fg(CYAN).add_modifier(Modifier::BOLD),
        ),
    ];
    if let Some(pid) = view.pid {
        identity.push(Span::raw(format!(" · pid {pid}")));
    }
    if let Some(up) = view.uptime {
        identity.push(Span::raw(format!(
            " · up {}",
            age(up).trim_end_matches(" ago")
        )));
    }
    let count = |s| {
        view.sessions
            .data
            .iter()
            .filter(|row| row.info.status == Some(s))
            .count()
    };
    let counts = if view.sessions.state.ready() {
        let unknown = view
            .sessions
            .data
            .iter()
            .filter(|row| row.info.status.is_none())
            .count();
        format!(
            "{} running · {} idle · {} busy{} · updated {}",
            count(SessionStatus::Running),
            count(SessionStatus::Idle),
            count(SessionStatus::Busy),
            if unknown > 0 {
                format!(" · {unknown} unknown")
            } else {
                String::new()
            },
            view.sessions.state.label(now).trim_start_matches("read ")
        )
    } else {
        view.sessions.state.label(now)
    };
    let mut lines = vec![
        Line::from(identity),
        Line::styled(
            if ready {
                view.daemon.data.clone()
            } else {
                view.daemon.state.label(now)
            },
            Style::default().fg(MUTED),
        ),
        Line::raw(counts),
    ];
    if view.memory.state.ready() {
        for (kind, label) in [
            ("episode", "episodic entries"),
            ("rule", "procedural rules"),
        ] {
            lines.push(Line::from(vec![
                Span::styled(format!("{label:<20}"), Style::default().fg(MUTED)),
                Span::styled(
                    format!(
                        "{} read",
                        number(view.memory.data.iter().filter(|m| m.kind == kind).count() as u64)
                    ),
                    Style::default().fg(CYAN),
                ),
            ]));
        }
    } else {
        lines.push(Line::raw(format!(
            "Memory · {}",
            view.memory.state.label(now)
        )));
    }
    lines.push(Line::raw(if view.dashboard.state.ready() {
        match &view.dashboard.data {
            Some(url) => format!("Dashboard (private): {url}"),
            None => "Dashboard disabled or unavailable".into(),
        }
    } else {
        format!("Dashboard · {}", view.dashboard.state.label(now))
    }));
    frame.render_widget(
        Paragraph::new(lines)
            .wrap(Wrap { trim: false })
            .block(panel(if view.demo {
                " Bots · /bots · OFFLINE DEMO "
            } else {
                " Bots · /bots · daemon overview "
            })),
        *header,
    );
    let Some(table) = parts.get(2) else {
        return;
    };
    let optional = [
        view.sessions.data.iter().any(|r| r.input.is_some()),
        view.sessions.data.iter().any(|r| r.output.is_some()),
        view.sessions
            .data
            .iter()
            .any(|r| r.cost.is_some_and(|n| n.is_finite() && n >= 0.0)),
        view.sessions.data.iter().any(|r| r.age.is_some()),
    ];
    let mut names = vec![
        Cell::from("Agent / session"),
        Cell::from("Model"),
        Cell::from("Status"),
    ];
    let mut widths = vec![
        Constraint::Fill(2),
        Constraint::Fill(2),
        Constraint::Length(11),
    ];
    for (show, name) in optional.into_iter().zip(["In", "Out", "Cost", "Age"]) {
        if show {
            names.push(numeric(name));
            widths.push(Constraint::Length(10));
        }
    }
    names.push(numeric("Turns"));
    widths.push(Constraint::Length(7));
    let page = usize::from(table.height.saturating_sub(3)).max(1);
    let n = view.sessions.data.len();
    let first = view
        .session_selected
        .saturating_sub(page - 1)
        .min(n.saturating_sub(1));
    let rows = view.sessions.data.iter().skip(first).take(page).map(|r| {
        let (label, color) = status(r.info.status);
        let mut cells = vec![
            Cell::from(r.info.id.clone()),
            Cell::from(r.info.model.clone().unwrap_or_else(|| "—".into())),
            Cell::from(label).style(Style::default().fg(color)),
        ];
        let values = [
            r.input.map_or_else(|| "—".into(), number),
            r.output.map_or_else(|| "—".into(), number),
            money(r.cost),
            r.age.map_or_else(|| "—".into(), age),
        ];
        for (show, value) in optional.into_iter().zip(values) {
            if show {
                cells.push(numeric(value));
            }
        }
        cells.push(numeric(number(u64::from(r.info.turn_count))));
        Row::new(cells)
    });
    let mut selection = TableState::default()
        .with_selected((n > 0).then_some(view.session_selected.saturating_sub(first)));
    let height = table.height.min(
        u16::try_from(n.saturating_add(3))
            .unwrap_or(u16::MAX)
            .max(5),
    );
    frame.render_stateful_widget(
        Table::new(rows, widths)
            .header(Row::new(names).style(Style::default().fg(CYAN).add_modifier(Modifier::BOLD)))
            .block(panel(format!(" {} agents ", n)))
            .column_spacing(1)
            .row_highlight_style(Style::default().bg(PANEL))
            .highlight_symbol("› "),
        Rect { height, ..*table },
        &mut selection,
    );
    if n == 0 {
        frame.render_widget(
            Paragraph::new(if view.sessions.state.ready() {
                "No live agents".into()
            } else {
                view.sessions.state.label(now)
            }),
            Rect::new(table.x + 2, table.y + 2, table.width.saturating_sub(4), 2),
        );
    }
    if let Some(hints) = parts.get(3) {
        frame.render_widget(
            Paragraph::new("↑↓ move · Enter open · r refresh · Esc back")
                .style(Style::default().fg(MUTED)),
            *hints,
        );
    }
    if let Some(read) = parts.get(4) {
        frame.render_widget(
            Paragraph::new(format!(
                "rows {}-{}/{n} · {} · every 5s · read-only",
                if n > 0 { first + 1 } else { 0 },
                (first + page).min(n),
                view.sessions.state.label(now)
            ))
            .style(Style::default().fg(MUTED)),
            *read,
        );
    }
}
