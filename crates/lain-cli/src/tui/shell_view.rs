use ratatui::{
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph, Wrap},
    Frame,
};

use super::{
    app::{self, Overlay, Screen},
    state::{Scroll, State},
    theme::*,
};

fn selected() -> Style {
    Style::default()
        .fg(ACCENT)
        .bg(PANEL)
        .add_modifier(Modifier::BOLD)
}

pub fn tabs(frame: &mut Frame, area: Rect, state: &State) {
    let brand = [
        Span::styled(
            " lain",
            Style::default().fg(HI).add_modifier(Modifier::BOLD),
        ),
        Span::styled("  lainarchive   ", Style::default().fg(FAINT)),
    ];
    let labels = brand
        .into_iter()
        .chain(Screen::ALL.iter().enumerate().map(|(i, screen)| {
            Span::styled(
                format!(" {} {} ", i + 1, screen.name()),
                if *screen == state.screen {
                    Style::default()
                        .fg(TEXT)
                        .add_modifier(Modifier::BOLD | Modifier::UNDERLINED)
                        .underline_color(ACCENT)
                } else {
                    Style::default().fg(FAINT)
                },
            )
        }))
        .collect::<Vec<_>>();
    frame.render_widget(Paragraph::new(Line::from(labels)), area);
}

fn command_line(command: &app::Command, active: bool) -> Line<'static> {
    Line::styled(
        format!(" {}  /{}  {}", command.title, command.id, command.hint),
        if active {
            selected()
        } else {
            Style::default().fg(TEXT)
        },
    )
}

pub fn completion(frame: &mut Frame, area: Rect, state: &State) {
    let Some((commands, selected)) = state.slash() else {
        return;
    };
    let visible = usize::from(area.height.saturating_sub(2)).max(1);
    let start = selected.saturating_sub(visible - 1);
    let mut lines: Vec<_> = commands
        .iter()
        .enumerate()
        .skip(start)
        .take(visible)
        .map(|(i, c)| command_line(c, i == selected))
        .collect();
    if lines.is_empty() {
        lines.push(Line::from(" No matching commands · Enter shows an error"));
    }
    frame.render_widget(
        Paragraph::new(lines).block(Block::default().borders(Borders::ALL).title(Span::styled(
            " Slash commands · Tab/↑↓ select · Enter run · Esc close ",
            Style::default().fg(ACCENT),
        ))),
        area,
    );
}

pub fn overlay(frame: &mut Frame, state: &State, scroll: &mut Scroll) {
    let Some(overlay) = &state.overlay else {
        return;
    };
    if let Overlay::Publish { typed } = overlay {
        super::creator_view::confirm(frame, state, typed);
        return;
    }
    let (title, lines, height) = match overlay {
        Overlay::Palette { query, selected } => {
            let commands = app::matching(query);
            let visible = usize::from(frame.area().height.saturating_sub(9))
                .min(app::COMMANDS.len())
                .max(1);
            let start = selected.saturating_sub(visible - 1);
            let mut lines = vec![
                Line::styled(format!(" > {query}"), Style::default().fg(ACCENT)),
                Line::from(""),
            ];
            lines.extend(
                commands
                    .iter()
                    .enumerate()
                    .skip(start)
                    .take(visible)
                    .map(|(i, c)| command_line(c, i == *selected)),
            );
            if commands.is_empty() {
                lines.push(Line::from(" No matching commands"));
            }
            lines.push(Line::styled(
                " ↑↓/Tab select · Enter run · Esc back",
                Style::default().fg(MUTED),
            ));
            let height = lines.len() as u16 + 2;
            (" Commands ", lines, height)
        }
        Overlay::Help => {
            let mut lines = vec![Line::styled("Global keys", Style::default().fg(ACCENT))];
            lines.extend(
                app::GLOBAL_KEYS
                    .iter()
                    .map(|(key, text)| Line::from(format!("{key}  {text}"))),
            );
            lines.push(Line::styled(
                format!("{} keys", state.screen.name()),
                Style::default().fg(ACCENT),
            ));
            lines.extend(
                app::screen_keys(state.screen)
                    .iter()
                    .map(|(key, text)| Line::from(format!("{key}  {text}"))),
            );
            lines.push(Line::styled("Commands (/id)", Style::default().fg(ACCENT)));
            let width = usize::from(frame.area().width.saturating_sub(8).min(112)) / 2;
            for pair in app::COMMANDS.chunks(2) {
                let mut spans = vec![];
                for command in pair {
                    let text = super::launch_view::fit(
                        &format!("{} /{} {}", command.title, command.id, command.hint),
                        width.saturating_sub(1),
                    );
                    let padding = width.saturating_sub(Line::raw(&text).width());
                    spans.push(Span::raw(format!("{text}{}", " ".repeat(padding))));
                }
                lines.push(Line::from(spans));
            }
            let height = lines.len() as u16 + 2;
            (" Help · PgUp/PgDn scroll · Esc close ", lines, height)
        }
        Overlay::Publish { .. } => return,
        Overlay::Confirm(_) => (
            " Confirm ",
            vec![
                Line::styled(
                    "Discard current draft / session view?",
                    Style::default().fg(HI),
                ),
                Line::from("Any active turn will be cancelled; filesystem writes are not undone."),
                Line::from("Enter confirms · Esc keeps working"),
            ],
            6,
        ),
    };
    let outer = frame.area();
    let width = outer.width.saturating_sub(6).min(114);
    let height = height.min(outer.height.saturating_sub(2));
    let area = Rect::new(
        outer.x + (outer.width - width) / 2,
        outer.y + (outer.height - height) / 2,
        width,
        height,
    );
    frame.render_widget(Clear, area);
    let paragraph = Paragraph::new(lines)
        .style(Style::default().fg(TEXT).bg(BACKGROUND))
        .block(
            Block::default()
                .borders(Borders::ALL)
                .title(Span::styled(title, Style::default().fg(ACCENT))),
        );
    if matches!(state.overlay, Some(Overlay::Help)) {
        let paragraph = paragraph.wrap(Wrap { trim: false });
        let visible = area.height.saturating_sub(2);
        scroll.help_max = paragraph
            .line_count(area.width.saturating_sub(2).max(1))
            .saturating_sub(usize::from(visible))
            .min(usize::from(u16::MAX)) as u16;
        scroll.help_page = visible.saturating_sub(1).max(1);
        scroll.help = scroll.help.min(scroll.help_max);
        frame.render_widget(paragraph.scroll((scroll.help, 0)), area);
    } else {
        frame.render_widget(paragraph, area);
    }
}
