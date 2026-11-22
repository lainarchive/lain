use ratatui::{
    layout::{Constraint, Layout, Rect},
    style::Style,
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph, Wrap},
    Frame,
};

use super::{
    creator::{Creator, Operation, Step},
    state::{Scroll, State},
    theme::*,
};
use crate::render::clean;

fn panel(title: &str) -> Block<'_> {
    Block::default()
        .borders(Borders::ALL)
        .title(title)
        .border_style(Style::default().fg(MUTED))
}

pub fn draw(frame: &mut Frame, area: Rect, state: &State, scroll: &mut Scroll) {
    let creator = &state.creator;
    let sections = Layout::vertical([
        Constraint::Length(3),
        Constraint::Length(3),
        Constraint::Min(4),
    ])
    .split(area);
    if let Some(area) = sections.first() {
        let mut spans = vec![];
        for step in Step::ALL {
            if !spans.is_empty() {
                spans.push(Span::raw(" → "));
            }
            spans.push(Span::styled(
                step.name(),
                Style::default().fg(if creator.step == step { CYAN } else { MUTED }),
            ));
        }
        frame.render_widget(
            Paragraph::new(Line::from(spans)).block(panel(" Creator · /creator ")),
            *area,
        );
    }
    if let Some(area) = sections.get(1) {
        let mut lines = vec![];
        if let Some(template) = &creator.template {
            lines.push(Line::from(format!(
                "Template: {} · source not fetched; supply new source and choose a unique name",
                clean(template)
            )));
        }
        let status = if creator.busy {
            "Creator request running · editing locked · switching screens is safe".into()
        } else if creator.step == Step::Schema {
            match creator.schema_value() {
                Ok(_) => "Valid schema".into(),
                Err(error) => format!("Invalid schema: {error}"),
            }
        } else if matches!(creator.step, Step::Test | Step::Publish) {
            creator.disabled(state.mode, if creator.step == Step::Test {Operation::Test} else {Operation::Publish})
                    .unwrap_or_else(|| "Scripts run unsandboxed as the host user, including Test. Publish tests again before writing.".into())
        } else {
            "Tab/Shift+Tab or Ctrl+←/→ steps · Alt+←/→ screens · draft kept · F1 help".into()
        };
        lines.push(Line::styled(clean(&status), Style::default().fg(AMBER)));
        if let Some(error) = &creator.error {
            lines.push(Line::styled(clean(error), Style::default().fg(RED)));
        }
        frame.render_widget(Paragraph::new(lines), *area);
    }
    let Some(area) = sections.get(2) else {
        return;
    };
    match creator.step {
        Step::Name => {
            let fields = Layout::vertical([Constraint::Length(4), Constraint::Min(3)]).split(*area);
            if let Some(area) = fields.first() {
                if !creator.editing_description {
                    frame.render_widget(&creator.name, *area);
                } else {
                    frame.render_widget(
                        Paragraph::new(creator.name.lines().join("\n"))
                            .block(panel(" Name · Enter switches field ")),
                        *area,
                    );
                }
            }
            if let Some(area) = fields.get(1) {
                if creator.editing_description {
                    frame.render_widget(&creator.description, *area);
                } else {
                    frame.render_widget(
                        Paragraph::new(creator.description.lines().join("\n"))
                            .block(panel(" Description · Enter switches field ")),
                        *area,
                    );
                }
            }
        }
        Step::Schema => frame.render_widget(&creator.schema, *area),
        Step::Interpreter => {
            let lines = [
                lain_core::plugin::manifest::ScriptInterpreter::Python,
                lain_core::plugin::manifest::ScriptInterpreter::Powershell,
                lain_core::plugin::manifest::ScriptInterpreter::Node,
            ]
            .into_iter()
            .map(|interpreter| {
                Line::styled(
                    format!(
                        "{} {interpreter:?} (.{} )",
                        if creator.interpreter == interpreter {
                            "›"
                        } else {
                            " "
                        },
                        interpreter.extension()
                    ),
                    Style::default().fg(if creator.interpreter == interpreter {
                        CYAN
                    } else {
                        TEXT
                    }),
                )
            })
            .collect::<Vec<_>>();
            frame.render_widget(
                Paragraph::new(lines).block(panel(" Interpreter · ↑↓ choose ")),
                *area,
            );
        }
        Step::Source => frame.render_widget(&creator.source, *area),
        Step::Test => {
            let columns =
                Layout::horizontal([Constraint::Percentage(45), Constraint::Percentage(55)])
                    .split(*area);
            if let Some(area) = columns.first() {
                frame.render_widget(&creator.args, *area);
            }
            if let Some(area) = columns.get(1) {
                output(frame, *area, creator, scroll);
            }
        }
        Step::Publish => output(frame, *area, creator, scroll),
    }
}

fn output(frame: &mut Frame, area: Rect, creator: &Creator, scroll: &mut Scroll) {
    let mut lines: Vec<Line<'static>> = vec![];
    if let Some(error) = &creator.error {
        lines.extend(
            clean(error)
                .lines()
                .map(|line| Line::styled(line.to_owned(), Style::default().fg(RED))),
        );
    }
    if let Some(report) = &creator.report {
        lines.push(Line::styled(
            format!(
                "{} {}{}",
                if report.simulated {
                    "SIMULATED"
                } else {
                    "Daemon"
                },
                report.operation.name(),
                if report.simulated {
                    " · no script executed; no files written"
                } else {
                    ""
                }
            ),
            Style::default().fg(CYAN),
        ));
        lines.push(Line::from(format!(
            "Exit: {} · Duration: {} ms",
            report
                .execution
                .exit_code
                .map(|code| code.to_string())
                .unwrap_or_else(|| "unknown".into()),
            report.execution.duration_ms
        )));
        for (title, text) in [
            ("Stdout", report.execution.stdout.clone()),
            ("Stderr", report.execution.stderr.clone()),
            (
                "Result",
                report
                    .execution
                    .result
                    .as_ref()
                    .and_then(|value| serde_json::to_string_pretty(value).ok())
                    .unwrap_or_else(|| "<none>".into()),
            ),
        ] {
            lines.push(Line::styled(title, Style::default().fg(CYAN)));
            lines.extend(clean(&text).lines().map(|line| Line::from(line.to_owned())));
            if text.is_empty() {
                lines.push(Line::from("<empty>"));
            }
        }
        if let Some(error) = &report.execution.error {
            lines.extend(
                clean(error)
                    .lines()
                    .map(|line| Line::styled(line.to_owned(), Style::default().fg(RED))),
            );
        }
        for path in &report.paths {
            lines.push(Line::from(format!(
                "{} {}",
                if report.simulated {
                    "Would write:"
                } else {
                    "Written:"
                },
                clean(&path.display().to_string())
            )));
        }
    } else {
        lines.push(Line::from(if creator.step == Step::Publish {
            "Enter reviews files and permissions; nothing is written until typed confirmation."
        } else {
            "Enter runs Test · Shift+Enter inserts a sample-input newline"
        }));
        if creator.step == Step::Publish {
            for path in creator.paths() {
                lines.push(Line::from(clean(&path.display().to_string())));
            }
        }
    }
    let paragraph = Paragraph::new(lines).wrap(Wrap { trim: false });
    let visible = area.height.saturating_sub(2);
    scroll.creator_max = paragraph
        .line_count(area.width.saturating_sub(2))
        .saturating_sub(usize::from(visible))
        .min(usize::from(u16::MAX)) as u16;
    scroll.creator_page = visible.saturating_sub(1).max(1);
    scroll.creator_output = scroll.creator_output.min(scroll.creator_max);
    frame.render_widget(
        paragraph
            .scroll((scroll.creator_output, 0))
            .block(panel(" Execution report · PgUp/PgDn ")),
        area,
    );
}

pub fn confirm(frame: &mut Frame, state: &State, typed: &str) {
    let outer = frame.area();
    let area = Rect::new(
        outer.x + (outer.width.saturating_sub(114)) / 2,
        outer.y + (outer.height.saturating_sub(20)) / 2,
        outer.width.min(114),
        outer.height.min(20),
    );
    let mut lines = vec![Line::styled(
        "Publish executes the script again before writing these exact workspace-relative files:",
        Style::default().fg(AMBER),
    )];
    for path in state.creator.paths() {
        lines.push(Line::from(clean(&path.display().to_string())));
    }
    lines.extend([Line::from(""), Line::from("Required permissions: read_fs · write_fs · network · subprocess"),
        Line::styled("Scripts run unsandboxed as the host user, not in a security sandbox.", Style::default().fg(RED)),
        Line::from("The daemon refuses existing paths or duplicate tools. Rewind cannot undo these writes."),
        Line::from(""), Line::from("Type exactly lowercase y, then Enter to publish. Esc cancels."), Line::from(format!("> {}", clean(typed)))]);
    if let Some(reason) = state.creator.disabled(state.mode, Operation::Publish) {
        lines.push(Line::styled(clean(&reason), Style::default().fg(RED)));
    }
    frame.render_widget(Clear, area);
    frame.render_widget(
        Paragraph::new(lines)
            .wrap(Wrap { trim: false })
            .style(Style::default().fg(TEXT).bg(BACKGROUND))
            .block(panel(" Confirm publish ")),
        area,
    );
}
