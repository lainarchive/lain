use std::path::PathBuf;

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use lain_core::plugin::{
    manifest::{Backend, ScriptInterpreter},
    MAX_SCRIPT_BYTES,
};
use lain_ipc::{ManifestEntry, ScriptExecution, ScriptProposal};
use ratatui::{
    style::{Modifier, Style},
    widgets::{Block, Borders},
};
use ratatui_textarea::TextArea;
use serde_json::Value;

use super::{
    state::{Effect, Mode, Scroll},
    theme::*,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    Name,
    Schema,
    Interpreter,
    Source,
    Test,
    Publish,
}

impl Step {
    pub const ALL: [Self; 6] = [
        Self::Name,
        Self::Schema,
        Self::Interpreter,
        Self::Source,
        Self::Test,
        Self::Publish,
    ];
    pub fn name(self) -> &'static str {
        match self {
            Self::Name => "Name/description",
            Self::Schema => "Input schema",
            Self::Interpreter => "Interpreter",
            Self::Source => "Source",
            Self::Test => "Test",
            Self::Publish => "Publish",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Operation {
    Test,
    Publish,
}

impl Operation {
    pub fn name(self) -> &'static str {
        match self {
            Self::Test => "test",
            Self::Publish => "publish",
        }
    }
}

pub struct Report {
    pub operation: Operation,
    pub execution: ScriptExecution,
    pub paths: Vec<PathBuf>,
    pub simulated: bool,
}

pub struct Creator {
    pub step: Step,
    pub name: TextArea<'static>,
    pub description: TextArea<'static>,
    pub schema: TextArea<'static>,
    pub source: TextArea<'static>,
    pub args: TextArea<'static>,
    pub interpreter: ScriptInterpreter,
    pub allowed: Option<bool>,
    pub access_error: Option<String>,
    pub access_loaded: bool,
    pub busy: bool,
    pub dirty: bool,
    pub error: Option<String>,
    pub report: Option<Report>,
    pub template: Option<String>,
    pub editing_description: bool,
}

pub fn editor(text: &str, title: &'static str) -> TextArea<'static> {
    let mut area = TextArea::from(text.split('\n').map(str::to_owned).collect::<Vec<_>>());
    area.set_style(Style::default().fg(TEXT).bg(BACKGROUND));
    area.set_cursor_line_style(Style::default().bg(PANEL));
    area.set_cursor_style(
        Style::default()
            .fg(BACKGROUND)
            .bg(ACCENT)
            .add_modifier(Modifier::BOLD),
    );
    area.set_block(Block::default().borders(Borders::ALL).title(title));
    area
}

impl Default for Creator {
    fn default() -> Self {
        Self {
            step: Step::Name,
            name: editor("", " Name "),
            description: editor("", " Description "),
            schema: editor(
                "{\n  \"type\": \"object\",\n  \"properties\": {}\n}",
                " Input schema · JSON ",
            ),
            source: editor("", " Source · host script · spaces indent "),
            args: editor("{}", " Sample input · JSON "),
            interpreter: ScriptInterpreter::Python,
            allowed: None,
            access_error: None,
            access_loaded: false,
            busy: false,
            dirty: false,
            error: None,
            report: None,
            template: None,
            editing_description: false,
        }
    }
}

impl Creator {
    pub fn sample() -> Self {
        Self { name:editor("demo_created", " Name "), description:editor("Echo a sample value", " Description "),
            source:editor("import json, sys\nrequest = json.load(sys.stdin)\nprint(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': request['params']}))", " Source · Python "),
            args:editor("{\"value\": \"demo\"}", " Sample input · JSON "), allowed:Some(true), access_loaded:true, ..Self::default() }
    }

    pub fn prefill(&mut self, entry: &ManifestEntry) {
        let Ok(manifest) = &entry.manifest else {
            return;
        };
        let mut draft = Self {
            allowed: self.allowed,
            access_loaded: self.access_loaded,
            access_error: self.access_error.clone(),
            name: editor(&manifest.name, " Name "),
            template: Some(manifest.name.clone()),
            dirty: true,
            ..Self::default()
        };
        if let Some(tool) = manifest.tools.first() {
            draft.name = editor(&tool.name, " Name ");
            draft.description = editor(&tool.description, " Description ");
            draft.schema = editor(
                &serde_json::to_string_pretty(&tool.parameters).unwrap_or_default(),
                " Input schema · JSON ",
            );
            if let Backend::Script { interpreter, .. } = tool.backend {
                draft.interpreter = interpreter;
            }
        }
        *self = draft;
    }

    pub fn set_access(&mut self, allowed: bool) {
        self.allowed = Some(allowed);
        self.access_loaded = true;
        self.access_error = None;
    }

    pub fn reset_access(&mut self) {
        self.allowed = None;
        self.access_loaded = false;
        self.access_error = None;
        if self.busy {
            self.error = Some("Session changed; previous Creator request may still finish. Filesystem writes are not undone.".into());
        }
        self.busy = false;
    }

    pub fn disabled(&self, mode: Mode, operation: Operation) -> Option<String> {
        if operation == Operation::Publish && mode.read_only() {
            return Some(format!(
                "Publish disabled: {} is read-only; select Code in Ctrl+K",
                mode.name()
            ));
        }
        if self.busy {
            return Some("Creator request in progress; editing is locked".into());
        }
        if let Some(error) = &self.access_error {
            return Some(error.clone());
        }
        match self.allowed {
            Some(true) => None,
            Some(false) => {
                Some("Daemon creator mode is disabled (allow_creator_mode is off)".into())
            }
            None => Some(
                "Checking daemon creator mode; publishing remains disabled until confirmed".into(),
            ),
        }
    }

    pub fn schema_value(&self) -> Result<Value, String> {
        let schema: Value = serde_json::from_str(&self.schema.lines().join("\n"))
            .map_err(|error| error.to_string())?;
        if !schema.is_object() {
            return Err("schema must be a JSON object".into());
        }
        jsonschema::validator_for(&schema).map_err(|error| error.to_string())?;
        Ok(schema)
    }

    pub fn proposal(&self) -> Result<ScriptProposal, String> {
        let name = self.name.lines().join("\n");
        if name.is_empty()
            || name.len() > 64
            || !name
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
        {
            return Err("Name needs 1–64 ASCII letters, digits, hyphens or underscores".into());
        }
        let description = self.description.lines().join("\n");
        if description.trim().is_empty() {
            return Err("Description is required".into());
        }
        let parameters = self
            .schema_value()
            .map_err(|error| format!("Invalid schema: {error}"))?;
        let source = self.source.lines().join("\n");
        if source.is_empty() || source.len() > MAX_SCRIPT_BYTES {
            return Err(format!("Source needs 1–{MAX_SCRIPT_BYTES} bytes"));
        }
        let test_args: Value = serde_json::from_str(&self.args.lines().join("\n"))
            .map_err(|error| format!("Invalid sample input: {error}"))?;
        jsonschema::validator_for(&parameters)
            .map_err(|error| error.to_string())?
            .validate(&test_args)
            .map_err(|error| format!("Sample input: {error}"))?;
        Ok(ScriptProposal {
            name,
            description,
            parameters,
            source,
            test_args,
            interpreter: self.interpreter,
        })
    }

    pub fn paths(&self) -> Vec<PathBuf> {
        let name = self.name.lines().join("");
        vec![
            format!(".lain/tools/tool-{name}.{}", self.interpreter.extension()).into(),
            format!(".lain/tools/tool-{name}.json").into(),
        ]
    }

    pub fn request(&mut self, mode: Mode, operation: Operation) -> Effect {
        if let Some(error) = self
            .disabled(mode, operation)
            .or_else(|| self.proposal().err())
        {
            self.error = Some(error);
            Effect::None
        } else {
            Effect::Creator(operation)
        }
    }

    fn edited(&mut self) {
        self.dirty = true;
        self.report = None;
        self.error = None;
    }

    fn active_editor(&mut self) -> Option<&mut TextArea<'static>> {
        match self.step {
            Step::Name if self.editing_description => Some(&mut self.description),
            Step::Name => Some(&mut self.name),
            Step::Schema => Some(&mut self.schema),
            Step::Source => Some(&mut self.source),
            Step::Test => Some(&mut self.args),
            _ => None,
        }
    }

    pub fn paste(&mut self, text: &str) {
        if self.busy {
            return;
        }
        let text = crate::render::clean(&text.replace("\r\n", "\n"));
        if let Some(area) = self.active_editor() {
            if area.lines().join("\n").len() + text.len() > MAX_SCRIPT_BYTES {
                self.error = Some("Editor limit: 65536 bytes".into());
            } else {
                area.insert_str(text);
                self.edited();
            }
        }
    }

    pub fn key(&mut self, key: KeyEvent, mode: Mode, scroll: &mut Scroll) -> Effect {
        let forward = key.code == KeyCode::Tab && !key.modifiers.contains(KeyModifiers::SHIFT)
            || key.code == KeyCode::Right && key.modifiers.contains(KeyModifiers::CONTROL);
        let backward = key.code == KeyCode::BackTab
            || key.code == KeyCode::Tab && key.modifiers.contains(KeyModifiers::SHIFT)
            || key.code == KeyCode::Left && key.modifiers.contains(KeyModifiers::CONTROL);
        if forward || backward {
            let index = Step::ALL
                .iter()
                .position(|step| *step == self.step)
                .unwrap_or(0);
            self.step = Step::ALL
                .get(if forward {
                    (index + 1).min(5)
                } else {
                    index.saturating_sub(1)
                })
                .copied()
                .unwrap_or(Step::Name);
            scroll.creator_output = 0;
            return Effect::None;
        }
        if self.busy {
            return Effect::None;
        }
        if matches!(self.step, Step::Test | Step::Publish)
            && matches!(key.code, KeyCode::PageDown | KeyCode::PageUp)
        {
            scroll.creator_output = if key.code == KeyCode::PageDown {
                scroll
                    .creator_output
                    .saturating_add(scroll.creator_page.max(1))
                    .min(scroll.creator_max)
            } else {
                scroll
                    .creator_output
                    .saturating_sub(scroll.creator_page.max(1))
            };
            return Effect::None;
        }
        match self.step {
            Step::Name if key.code == KeyCode::Enter => {
                self.editing_description = !self.editing_description
            }
            Step::Interpreter
                if matches!(
                    key.code,
                    KeyCode::Up | KeyCode::Down | KeyCode::Left | KeyCode::Right
                ) =>
            {
                self.interpreter = match (
                    self.interpreter,
                    matches!(key.code, KeyCode::Down | KeyCode::Right),
                ) {
                    (ScriptInterpreter::Python, true) | (ScriptInterpreter::Node, false) => {
                        ScriptInterpreter::Powershell
                    }
                    (ScriptInterpreter::Powershell, true) | (ScriptInterpreter::Python, false) => {
                        ScriptInterpreter::Node
                    }
                    _ => ScriptInterpreter::Python,
                };
                self.source.set_block(
                    Block::default()
                        .borders(Borders::ALL)
                        .title(format!(" Source · {:?} ", self.interpreter)),
                );
                self.edited();
            }
            Step::Test
                if key.code == KeyCode::Enter && !key.modifiers.contains(KeyModifiers::SHIFT) =>
            {
                return self.request(mode, Operation::Test)
            }
            Step::Publish => {}
            _ => {
                if let Some(area) = self.active_editor() {
                    if area.input(key) {
                        self.edited();
                    }
                }
            }
        }
        Effect::None
    }

    pub fn finish(
        &mut self,
        operation: Operation,
        execution: ScriptExecution,
        paths: Vec<PathBuf>,
        simulated: bool,
    ) {
        self.busy = false;
        self.error = None;
        if operation == Operation::Publish && execution.error.is_none() && !simulated {
            self.dirty = false;
        }
        self.report = Some(Report {
            operation,
            execution,
            paths,
            simulated,
        });
    }

    pub fn simulate(&mut self, operation: Operation) -> Result<(), String> {
        let proposal = self.proposal()?;
        let paths = if operation == Operation::Publish {
            self.paths()
        } else {
            vec![]
        };
        self.finish(
            operation,
            ScriptExecution {
                exit_code: Some(0),
                stdout: "demo JSON-RPC response (not executed)".into(),
                stderr: String::new(),
                result: Some(proposal.test_args),
                duration_ms: 12,
                error: None,
            },
            paths,
            true,
        );
        Ok(())
    }
}
