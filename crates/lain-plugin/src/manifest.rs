use std::{collections::BTreeSet, path::PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    ReadFs,
    WriteFs,
    Network,
    Subprocess,
}

pub const HOST_PROCESS_PERMISSIONS: [Capability; 4] = [
    Capability::ReadFs,
    Capability::WriteFs,
    Capability::Network,
    Capability::Subprocess,
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginManifest {
    pub name: String,
    pub version: String,
    pub permissions: BTreeSet<Capability>,
    pub tools: Vec<ToolExport>,
    pub author: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolExport {
    pub name: String,
    pub description: String,
    pub parameters: Value,
    pub backend: Backend,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Backend {
    Script {
        interpreter: ScriptInterpreter,
        path: PathBuf,
    },
    Cli {
        program: PathBuf,
        #[serde(default)]
        args: Vec<String>,
    },
    Webhook {
        url: String,
    },
}

impl Backend {
    pub(crate) fn required_permissions(&self) -> &[Capability] {
        match self {
            // A host process has these rights irrespective of what its manifest claims.
            Self::Script { .. } | Self::Cli { .. } => &HOST_PROCESS_PERMISSIONS,
            Self::Webhook { .. } => &[Capability::Network],
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScriptInterpreter {
    Python,
    Powershell,
    Node,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScriptProposal {
    pub name: String,
    pub description: String,
    pub parameters: Value,
    pub interpreter: ScriptInterpreter,
    pub source: String,
    pub test_args: Value,
}

impl ScriptInterpreter {
    pub fn extension(self) -> &'static str {
        match self {
            Self::Python => "py",
            Self::Powershell => "ps1",
            Self::Node => "js",
        }
    }
}

pub(crate) fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
}
