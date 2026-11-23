use std::collections::BTreeMap;

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use lain_core::plugin::manifest::{Backend, Capability, HOST_PROCESS_PERMISSIONS};
use lain_ipc::{ActiveTool, Command, Event, IpcClient, ManifestEntry, PermissionGrant, ToolSource};
use ratatui::{
    layout::{Constraint, Layout, Rect},
    style::{Color, Style},
    text::Line,
    widgets::{Block, Borders, List, ListItem, ListState, Paragraph, Wrap},
    Frame,
};

use super::{state::Scroll, theme::*};
use crate::{render::clean, Error};

#[derive(Clone, Copy)]
enum Row {
    Manifest(usize),
    Tool(usize),
}

#[derive(Default)]
pub struct Plugins {
    pub manifests: Vec<ManifestEntry>,
    pub tools: Vec<ActiveTool>,
    pub filter: String,
    pub filtering: bool,
    pub loaded: bool,
    pub inventory_error: Option<String>,
    pub tools_error: Option<String>,
    selected: usize,
    generation: u64,
    inventory_loading: bool,
    tools_loading: bool,
}

impl Plugins {
    pub fn refresh(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        self.loaded = false;
        self.manifests.clear();
        self.tools.clear();
        self.inventory_error = None;
        self.tools_error = None;
        self.inventory_loading = false;
        self.tools_loading = false;
        self.selected = 0;
    }

    pub fn sample() -> Result<Self, serde_json::Error> {
        let manifest = serde_json::from_value(serde_json::json!({
            "name":"echo", "version":"1.0.0", "author":"demo fixture", "permissions":["network"],
            "tools":[{"name":"demo_echo", "description":"Echo a sample value through a webhook.",
                "parameters":{"type":"object","properties":{"value":{"type":"string"}}},
                "backend":{"kind":"webhook","url":"https://example.invalid/echo"}}]
        }))?;
        Ok(Self {
            loaded: true,
            manifests: vec![
                ManifestEntry {
                    path: ".lain/plugins/echo.json".into(),
                    manifest: Ok(manifest),
                },
                ManifestEntry {
                    path: ".lain/plugins/broken.json".into(),
                    manifest: Err("invalid JSON: expected value at line 1".into()),
                },
            ],
            tools: vec![
                ActiveTool {
                    name: "demo_echo".into(),
                    description: "Echo a sample value through a webhook.".into(),
                    parameters: serde_json::json!({"type":"object","properties":{"value":{"type":"string"}}}),
                    source: ToolSource::Plugin {
                        manifest_name: "echo".into(),
                        manifest_path: Some(".lain/plugins/echo.json".into()),
                    },
                    permissions: vec![PermissionGrant {
                        capability: Capability::Network,
                        granted: true,
                    }],
                },
                ActiveTool {
                    name: "create_tool".into(),
                    description: "Creator publishing requires Code mode and creator mode enabled."
                        .into(),
                    parameters: serde_json::json!({"type":"object","properties":{"name":{"type":"string"}}}),
                    source: ToolSource::Builtin,
                    permissions: HOST_PROCESS_PERMISSIONS
                        .into_iter()
                        .map(|capability| PermissionGrant {
                            capability,
                            granted: capability != Capability::Subprocess,
                        })
                        .collect(),
                },
            ],
            ..Self::default()
        })
    }

    pub fn load_demo(&mut self) -> Result<(), Error> {
        let sample = super::demo::catalog()?;
        self.manifests = sample.manifests;
        self.tools = sample.tools;
        self.loaded = true;
        self.inventory_loading = false;
        self.tools_loading = false;
        Ok(())
    }

    fn label(&self, row: Row) -> String {
        match row {
            Row::Manifest(index) => self
                .manifests
                .get(index)
                .map(|entry| match &entry.manifest {
                    Ok(manifest) => format!("◆ {} · {}", manifest.name, entry.path.display()),
                    Err(_) => format!("× {}", entry.path.display()),
                })
                .unwrap_or_default(),
            Row::Tool(index) => self
                .tools
                .get(index)
                .map(|tool| format!("› {} · {}", tool.name, source(&tool.source)))
                .unwrap_or_default(),
        }
    }

    fn rows(&self) -> Vec<Row> {
        let query = self.filter.trim().to_lowercase();
        (0..self.manifests.len())
            .map(Row::Manifest)
            .chain((0..self.tools.len()).map(Row::Tool))
            .filter(|row| self.label(*row).to_lowercase().contains(&query))
            .collect()
    }

    pub fn key(
        &mut self,
        key: KeyEvent,
        scroll: &mut Scroll,
    ) -> Result<Option<ManifestEntry>, &'static str> {
        if self.filtering {
            match key.code {
                KeyCode::Esc => {
                    self.filter.clear();
                    self.filtering = false;
                }
                KeyCode::Enter => self.filtering = false,
                KeyCode::Backspace => {
                    self.filter.pop();
                }
                KeyCode::Char(c)
                    if !key
                        .modifiers
                        .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
                {
                    self.filter.push(c)
                }
                _ => return Ok(None),
            }
            self.selected = 0;
            scroll.plugin_detail = 0;
            return Ok(None);
        }
        match key.code {
            KeyCode::Char('/') => self.filtering = true,
            KeyCode::Char('r') => {
                self.refresh();
                scroll.plugin_detail = 0;
            }
            KeyCode::Esc => {
                self.filter.clear();
                self.selected = 0;
                scroll.plugin_detail = 0;
            }
            KeyCode::Up | KeyCode::Down => {
                self.selected = if key.code == KeyCode::Up {
                    self.selected.saturating_sub(1)
                } else {
                    (self.selected + 1).min(self.rows().len().saturating_sub(1))
                };
                scroll.plugin_detail = 0;
            }
            KeyCode::PageDown => {
                scroll.plugin_detail = scroll
                    .plugin_detail
                    .saturating_add(scroll.plugin_page.max(1))
                    .min(scroll.plugin_max)
            }
            KeyCode::PageUp => {
                scroll.plugin_detail = scroll
                    .plugin_detail
                    .saturating_sub(scroll.plugin_page.max(1))
            }
            KeyCode::Enter => {
                if let Some(Row::Manifest(index)) = self.rows().get(self.selected) {
                    if let Some(entry) = self.manifests.get(*index) {
                        if entry.manifest.is_err() {
                            return Err("Cannot template a malformed manifest");
                        }
                        return Ok(Some(entry.clone()));
                    }
                }
            }
            _ => {}
        }
        Ok(None)
    }

    fn details(&self) -> Vec<Line<'static>> {
        let mut lines = vec![];
        for error in [&self.inventory_error, &self.tools_error]
            .into_iter()
            .flatten()
        {
            push(&mut lines, error, RED);
        }
        match self.rows().get(self.selected).copied() {
            Some(Row::Manifest(index)) => {
                if let Some(entry) = self.manifests.get(index) {
                    lines.push(line(format!("Path: {}", entry.path.display()), MUTED));
                    match &entry.manifest {
                        Err(error) => {
                            lines.push(line("Load error", RED));
                            push(&mut lines, error, RED);
                        }
                        Ok(manifest) => {
                            lines.push(line(
                                format!(
                                    "{} · v{} · {}",
                                    manifest.name, manifest.version, manifest.author
                                ),
                                ACCENT,
                            ));
                            lines.push(line("Permissions", ACCENT));
                            for capability in &manifest.permissions {
                                let grant = self.tools.iter().filter(|tool| matches!(&tool.source,
                                ToolSource::Plugin {manifest_name, manifest_path:Some(path)} if manifest_name == &manifest.name && path == &entry.path))
                                .flat_map(|tool| &tool.permissions).find(|grant| grant.capability == *capability).map(|grant| grant.granted);
                                lines.push(permission(*capability, grant));
                            }
                            for export in &manifest.tools {
                                lines.push(line(format!("Export: {}", export.name), HI));
                                push(&mut lines, &export.description, TEXT);
                                lines.push(line(backend(&export.backend), MUTED));
                                schema(&mut lines, &export.parameters);
                            }
                        }
                    }
                }
            }
            Some(Row::Tool(index)) => {
                if let Some(tool) = self.tools.get(index) {
                    lines.push(line(&tool.name, ACCENT));
                    push(&mut lines, &tool.description, TEXT);
                    lines.push(line(format!("Source: {}", source(&tool.source)), MUTED));
                    match &tool.source {
                        ToolSource::Builtin => {
                            lines.push(line("Backend: builtin · Path: built-in", MUTED))
                        }
                        ToolSource::Plugin { manifest_path, .. } => {
                            lines.push(line(
                                format!(
                                    "Path: {}",
                                    manifest_path
                                        .as_ref()
                                        .map(|p| p.display().to_string())
                                        .unwrap_or_else(|| "unknown".into())
                                ),
                                MUTED,
                            ));
                            let export = self
                                .manifests
                                .iter()
                                .filter(|entry| Some(&entry.path) == manifest_path.as_ref())
                                .filter_map(|entry| entry.manifest.as_ref().ok())
                                .flat_map(|manifest| &manifest.tools)
                                .find(|export| export.name == tool.name);
                            lines.push(line(
                                export
                                    .map(|export| {
                                        format!(
                                            "{} (from disk inventory)",
                                            backend(&export.backend)
                                        )
                                    })
                                    .unwrap_or_else(|| {
                                        "Backend: unknown (manifest not in inventory)".into()
                                    }),
                                MUTED,
                            ));
                        }
                    }
                    lines.push(line("Permissions", ACCENT));
                    if tool.permissions.is_empty() {
                        lines.push(line("No workspace capabilities required", MUTED));
                    }
                    for grant in &tool.permissions {
                        lines.push(permission(grant.capability, Some(grant.granted)));
                    }
                    schema(&mut lines, &tool.parameters);
                }
            }
            None => lines.push(line("Select a manifest or active tool", MUTED)),
        }
        lines
    }
}

fn source(source: &ToolSource) -> String {
    match source {
        ToolSource::Builtin => "builtin".into(),
        ToolSource::Plugin { manifest_name, .. } => format!("plugin {manifest_name}"),
    }
}

fn backend(backend: &Backend) -> String {
    match backend {
        Backend::Script { interpreter, path } => {
            format!("Backend: script {interpreter:?} · {}", path.display())
        }
        Backend::Cli { program, .. } => format!("Backend: cli · {}", program.display()),
        Backend::Webhook { .. } => "Backend: webhook".into(),
    }
}

fn line(text: impl AsRef<str>, color: Color) -> Line<'static> {
    Line::styled(clean(text.as_ref()), Style::default().fg(color))
}

fn error_summary(error: &str) -> String {
    let mut text: String = error.chars().take(100).collect();
    if error.chars().count() > 100 {
        text.push('…');
    }
    text
}

fn push(lines: &mut Vec<Line<'static>>, text: &str, color: Color) {
    lines.extend(text.lines().map(|text| line(text, color)));
}

fn permission(capability: Capability, granted: Option<bool>) -> Line<'static> {
    let name = match capability {
        Capability::ReadFs => "read_fs",
        Capability::WriteFs => "write_fs",
        Capability::Network => "network",
        Capability::Subprocess => "subprocess",
    };
    match granted {
        Some(true) => line(format!("✓ {name}"), GREEN),
        Some(false) => line(format!("✗ {name}"), RED),
        None => line(format!("? {name} · grant unknown (not active)"), MUTED),
    }
}

fn schema(lines: &mut Vec<Line<'static>>, parameters: &serde_json::Value) {
    lines.push(line("Input schema", ACCENT));
    if let Ok(json) = serde_json::to_string_pretty(parameters) {
        push(lines, &json, TEXT);
    }
}

pub fn draw(frame: &mut Frame, area: Rect, plugins: &Plugins, scroll: &mut Scroll) {
    let columns =
        Layout::horizontal([Constraint::Percentage(42), Constraint::Percentage(58)]).split(area);
    let (Some(left), Some(right)) = (columns.first(), columns.get(1)) else {
        return;
    };
    let mut status = vec![line(
        format!(
            "Manifests {} · Active tools {}",
            plugins.manifests.len(),
            plugins.tools.len()
        ),
        MUTED,
    )];
    if plugins.inventory_loading || plugins.tools_loading {
        status.push(line("Loading plugin inventory…", ACCENT));
    }
    if let Some(error) = &plugins.inventory_error {
        status.push(line(error_summary(error), RED));
    }
    if let Some(error) = &plugins.tools_error {
        status.push(line(error_summary(error), RED));
    }
    let status = Paragraph::new(status).wrap(Wrap { trim: false });
    let height = status.line_count(left.width).min(8) as u16;
    let sections = Layout::vertical([
        Constraint::Length(3),
        Constraint::Length(height),
        Constraint::Min(3),
    ])
    .split(*left);
    if let Some(area) = sections.first() {
        frame.render_widget(
            Paragraph::new(clean(&plugins.filter)).block(
                Block::default()
                    .borders(Borders::ALL)
                    .title(if plugins.filtering {
                        " Filter · typing · Enter apply · Esc clear "
                    } else {
                        " Filter · / edit "
                    })
                    .border_style(Style::default().fg(if plugins.filtering {
                        ACCENT
                    } else {
                        MUTED
                    })),
            ),
            *area,
        );
    }
    if let Some(area) = sections.get(1) {
        frame.render_widget(status, *area);
    }
    let rows = plugins.rows();
    if let Some(area) = sections.get(2) {
        let block = Block::default()
            .borders(Borders::ALL)
            .title(" Plugins · /plugins ");
        if rows.is_empty() {
            frame.render_widget(
                Paragraph::new(if plugins.filter.is_empty() {
                    "No manifests or active tools"
                } else {
                    "No matching entries"
                })
                .block(block),
                *area,
            );
        } else {
            let items = rows
                .iter()
                .map(|row| {
                    ListItem::new(line(
                        plugins.label(*row),
                        match row {
                            Row::Manifest(index)
                                if plugins
                                    .manifests
                                    .get(*index)
                                    .is_some_and(|entry| entry.manifest.is_err()) =>
                            {
                                RED
                            }
                            Row::Manifest(_) => ACCENT,
                            Row::Tool(_) => HI,
                        },
                    ))
                })
                .collect::<Vec<_>>();
            frame.render_stateful_widget(
                List::new(items)
                    .block(block)
                    .highlight_symbol("› ")
                    .highlight_style(Style::default().bg(PANEL)),
                *area,
                &mut ListState::default().with_selected(Some(plugins.selected)),
            );
        }
    }
    let details = Paragraph::new(plugins.details()).wrap(Wrap { trim: false });
    let visible = right.height.saturating_sub(2);
    scroll.plugin_max = details
        .line_count(right.width.saturating_sub(2))
        .saturating_sub(usize::from(visible))
        .min(usize::from(u16::MAX)) as u16;
    scroll.plugin_detail = scroll.plugin_detail.min(scroll.plugin_max);
    scroll.plugin_page = visible.saturating_sub(1).max(1);
    frame.render_widget(
        details.scroll((scroll.plugin_detail, 0)).block(
            Block::default()
                .borders(Borders::ALL)
                .title(" Detail · PgUp/PgDn "),
        ),
        *right,
    );
}

#[derive(Clone, Copy)]
enum Request {
    Inventory,
    Tools,
}

impl Request {
    fn name(self) -> &'static str {
        match self {
            Self::Inventory => "ListPlugins",
            Self::Tools => "ListTools",
        }
    }
}

#[derive(Default)]
pub struct Requests {
    pending: BTreeMap<u64, (u64, Request)>,
}

impl Requests {
    pub fn clear(&mut self) -> Vec<u64> {
        std::mem::take(&mut self.pending).into_keys().collect()
    }

    pub async fn refresh(
        &mut self,
        client: &mut IpcClient,
        session: Option<&str>,
        plugins: &mut Plugins,
    ) -> Result<(), Error> {
        plugins.loaded = true;
        plugins.inventory_loading = true;
        let request = client.send(Command::ListPlugins).await?;
        self.pending
            .insert(request, (plugins.generation, Request::Inventory));
        if let Some(session_id) = session {
            plugins.tools_loading = true;
            let request = client
                .send(Command::ListTools {
                    session_id: session_id.into(),
                })
                .await?;
            self.pending
                .insert(request, (plugins.generation, Request::Tools));
        } else {
            plugins.tools_error =
                Some("No active session; start a new session to list tools".into());
        }
        Ok(())
    }

    pub fn event(&mut self, id: u64, event: &Event, plugins: &mut Plugins) -> bool {
        let Some((generation, kind)) = self.pending.remove(&id) else {
            return false;
        };
        if generation != plugins.generation {
            return true;
        }
        let error = match (kind, event) {
            (Request::Inventory, Event::Plugins { plugins: entries }) => {
                plugins.manifests = entries.clone();
                None
            }
            (Request::Tools, Event::Tools { tools, .. }) => {
                plugins.tools = tools.clone();
                None
            }
            (_, Event::Error { code, message }) => Some(
                if matches!(
                    code.as_str(),
                    "IPC_INVALID_FRAME" | "IPC_COMMAND_UNSUPPORTED"
                ) {
                    format!(
                        "Daemon does not support {} ({code}): {message}",
                        kind.name()
                    )
                } else {
                    format!("{} failed ({code}): {message}", kind.name())
                },
            ),
            _ => Some(format!(
                "{} failed: unexpected daemon response",
                kind.name()
            )),
        };
        match kind {
            Request::Inventory => {
                plugins.inventory_loading = false;
                plugins.inventory_error = error;
            }
            Request::Tools => {
                plugins.tools_loading = false;
                plugins.tools_error = error;
            }
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn correlated_errors_and_stale_refreshes_do_not_replace_inventory(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let mut plugins = Plugins::sample()?;
        let mut requests = Requests::default();
        requests
            .pending
            .insert(10, (plugins.generation, Request::Inventory));
        requests
            .pending
            .insert(11, (plugins.generation, Request::Tools));
        assert!(requests.event(
            10,
            &Event::Error {
                code: "IPC_INVALID_FRAME".into(),
                message: "unknown command".into()
            },
            &mut plugins
        ));
        assert!(plugins
            .inventory_error
            .as_deref()
            .is_some_and(|error| error.contains("Daemon does not support ListPlugins")));
        assert!(!requests.event(
            99,
            &Event::Error {
                code: "SESSION_BUSY".into(),
                message: "s".into()
            },
            &mut plugins
        ));
        plugins.refresh();
        assert!(requests.event(
            11,
            &Event::Tools {
                session_id: "old".into(),
                allow_creator_mode: true,
                tools: Plugins::sample()?.tools
            },
            &mut plugins
        ));
        assert!(plugins.tools.is_empty());
        assert!(plugins.tools_error.is_none());
        assert!(!plugins.tools_loading);
        requests
            .pending
            .insert(12, (plugins.generation, Request::Tools));
        assert!(requests.event(
            12,
            &Event::Error {
                code: "SESSION_NOT_FOUND".into(),
                message: "s".into()
            },
            &mut plugins
        ));
        assert!(plugins
            .tools_error
            .as_deref()
            .is_some_and(|error| error.contains("SESSION_NOT_FOUND")));
        let sample = Plugins::sample()?;
        requests
            .pending
            .insert(13, (plugins.generation, Request::Inventory));
        requests
            .pending
            .insert(14, (plugins.generation, Request::Tools));
        assert!(requests.event(
            14,
            &Event::Tools {
                session_id: "s".into(),
                allow_creator_mode: true,
                tools: sample.tools
            },
            &mut plugins
        ));
        assert_eq!(plugins.tools.len(), 2);
        assert!(plugins.tools_error.is_none());
        assert!(requests.event(
            13,
            &Event::Plugins {
                plugins: sample.manifests
            },
            &mut plugins
        ));
        assert_eq!(plugins.manifests.len(), 2);
        assert!(plugins.inventory_error.is_none());
        assert!(requests.clear().is_empty());
        Ok(())
    }
}
