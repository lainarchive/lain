use std::{
    collections::{BTreeMap, BTreeSet},
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        OnceLock,
    },
};

use async_trait::async_trait;
use cap_std::{ambient_authority, fs::Dir};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    manifest::{
        valid_name, Backend, Capability, PluginManifest, ScriptInterpreter, ToolExport,
        HOST_PROCESS_PERMISSIONS,
    },
    runtime::{webhook_url, Runtime},
    Plugin, PluginError,
};

pub const MAX_SCRIPT_BYTES: usize = 64 * 1024;
const MAX_MANIFEST_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ManifestEntry {
    pub path: PathBuf,
    pub manifest: Result<PluginManifest, String>,
}

#[derive(Debug, Clone)]
pub struct PluginManager {
    workspace: PathBuf,
    grants: BTreeSet<Capability>,
}

impl PluginManager {
    pub fn new(workspace: impl Into<PathBuf>, grants: BTreeSet<Capability>) -> Self {
        Self {
            workspace: workspace.into(),
            grants,
        }
    }

    pub fn discover(&self) -> Result<Vec<DynamicPlugin>, PluginError> {
        if !self.grants.contains(&Capability::ReadFs) {
            return Ok(Vec::new());
        }
        let mut plugins = Vec::new();
        self.visit_manifests(|directory, path, manifest_path| {
            let load = || {
                let manifest = read_manifest(directory, path)?;
                let plugin = self.prepare(manifest, |path| {
                    read_file(directory, path, MAX_SCRIPT_BYTES)
                })?;
                plugin.manifest_path.get_or_init(|| manifest_path);
                Ok::<_, PluginError>(plugin)
            };
            plugins.push(
                load().map_err(|e| PluginError::Invalid(format!("{}: {e}", path.display())))?,
            );
            Ok(())
        })?;
        Ok(plugins)
    }

    /// Reads manifest metadata without loading backends or requiring execution grants.
    pub fn inventory(&self) -> Result<Vec<ManifestEntry>, PluginError> {
        let mut entries = Vec::new();
        self.visit_manifests(|directory, path, manifest_path| {
            entries.push(ManifestEntry {
                path: manifest_path,
                manifest: read_manifest(directory, path).map_err(|error| error.to_string()),
            });
            Ok(())
        })?;
        Ok(entries)
    }

    fn visit_manifests(
        &self,
        mut visit: impl FnMut(&Dir, &Path, PathBuf) -> Result<(), PluginError>,
    ) -> Result<(), PluginError> {
        let root = self.workspace()?;
        for path in [".lain/plugins", ".lain/tools"] {
            let directory = match root.open_dir(path) {
                Ok(directory) => directory,
                Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
                Err(e) => return Err(e.into()),
            };
            let mut entries = Vec::new();
            for entry in directory.entries()? {
                let entry = entry?;
                let path = PathBuf::from(entry.file_name());
                if entry.file_type()?.is_file()
                    && matches!(extension(&path), Some("json" | "yaml" | "yml"))
                {
                    entries.push(path);
                }
            }
            entries.sort_unstable();
            for file in entries {
                visit(&directory, &file, Path::new(path).join(&file))?;
            }
        }
        Ok(())
    }

    pub fn prepare_script(
        &self,
        name: String,
        description: String,
        parameters: Value,
        interpreter: ScriptInterpreter,
        source: String,
    ) -> Result<DynamicPlugin, PluginError> {
        if source.is_empty() || source.len() > MAX_SCRIPT_BYTES {
            return Err(PluginError::Invalid(format!(
                "script source must contain 1..={MAX_SCRIPT_BYTES} bytes"
            )));
        }
        let manifest = PluginManifest {
            author: "Creator Mode".into(),
            version: "0.1.0".into(),
            permissions: HOST_PROCESS_PERMISSIONS.into_iter().collect(),
            tools: vec![ToolExport {
                backend: Backend::Script {
                    interpreter,
                    path: format!("tool-{name}.{}", interpreter.extension()).into(),
                },
                name: name.clone(),
                description,
                parameters,
            }],
            name,
        };
        manifest_bytes(&manifest)?;
        let mut plugin = self.prepare(manifest, |_| Ok(source.as_bytes().to_vec()))?;
        plugin.creator_workspace = Some(self.workspace.clone());
        Ok(plugin)
    }

    pub fn persist_script(&self, plugin: &DynamicPlugin) -> Result<PathBuf, PluginError> {
        self.require_grant("write generated tool", Capability::WriteFs)?;
        if plugin.creator_workspace.as_ref() != Some(&self.workspace) {
            return Err(PluginError::Invalid(
                "expected a script prepared for this workspace".into(),
            ));
        }
        let export = plugin.manifest.tools.first();
        let (path, source) = match (export.map(|e| &e.backend), plugin.runtimes.values().next()) {
            (Some(Backend::Script { path, .. }), Some(Runtime::Script { source, .. })) => {
                (path, source)
            }
            _ => return Err(PluginError::Invalid("expected a generated script".into())),
        };
        let manifest_name = format!("tool-{}.json", plugin.manifest.name);
        let bytes = manifest_bytes(&plugin.manifest)?;
        let root = self.workspace()?;
        let lain = create_directory(&root, ".lain")?;
        let tools = create_directory(&lain, "tools")?;
        write_new(&tools, path, source)?;
        if let Err(e) = publish_manifest(&tools, Path::new(&manifest_name), &bytes) {
            let _ = tools.remove_file(path);
            return Err(e.into());
        }
        plugin
            .manifest_path
            .get_or_init(|| Path::new(".lain/tools").join(manifest_name));
        Ok(Path::new(".lain/tools").join(path))
    }

    fn workspace(&self) -> Result<Dir, PluginError> {
        Ok(Dir::open_ambient_dir(&self.workspace, ambient_authority())?)
    }

    fn require_grant(&self, action: &str, capability: Capability) -> Result<(), PluginError> {
        self.grants
            .contains(&capability)
            .then_some(())
            .ok_or_else(|| PluginError::Permission(action.into(), capability))
    }

    fn prepare(
        &self,
        manifest: PluginManifest,
        read_source: impl Fn(&Path) -> Result<Vec<u8>, PluginError>,
    ) -> Result<DynamicPlugin, PluginError> {
        if !valid_name(&manifest.name)
            || manifest.author.trim().is_empty()
            || manifest.version.trim().is_empty()
            || manifest.tools.is_empty()
        {
            return Err(PluginError::Invalid(
                "manifest requires a valid name, author, version and tool exports".into(),
            ));
        }
        for capability in &manifest.permissions {
            self.require_grant(&manifest.name, *capability)?;
        }
        let mut runtimes = BTreeMap::new();
        for tool in &manifest.tools {
            if !valid_name(&tool.name)
                || tool.description.trim().is_empty()
                || !tool.parameters.is_object()
            {
                return Err(PluginError::Invalid(
                    "exports require a valid name, description and JSON schema object".into(),
                ));
            }
            for capability in tool.backend.required_permissions() {
                if !manifest.permissions.contains(capability) {
                    return Err(PluginError::Permission(tool.name.clone(), *capability));
                }
            }
            let runtime = match &tool.backend {
                Backend::Script { interpreter, path } => {
                    if path.as_os_str().is_empty()
                        || !path
                            .components()
                            .all(|part| matches!(part, Component::Normal(_)))
                        || extension(path) != Some(interpreter.extension())
                    {
                        return Err(PluginError::Invalid(format!(
                            "{} requires a relative .{} script path",
                            tool.name,
                            interpreter.extension()
                        )));
                    }
                    let source = read_source(path)?;
                    if source.is_empty() {
                        return Err(PluginError::Invalid(format!(
                            "{} script is empty",
                            tool.name
                        )));
                    }
                    Runtime::Script {
                        interpreter: *interpreter,
                        source,
                    }
                }
                Backend::Cli { program, args } => {
                    if !program.is_absolute() {
                        return Err(PluginError::Invalid(format!(
                            "{} requires an absolute executable path",
                            tool.name
                        )));
                    }
                    Runtime::Cli {
                        program: program.clone(),
                        args: args.clone(),
                    }
                }
                Backend::Webhook { url } => Runtime::Webhook(webhook_url(url)?),
            };
            if runtimes.insert(tool.name.clone(), runtime).is_some() {
                return Err(PluginError::Invalid(format!(
                    "duplicate tool export: {}",
                    tool.name
                )));
            }
        }
        Ok(DynamicPlugin {
            workspace: self.workspace.clone(),
            manifest,
            runtimes,
            creator_workspace: None,
            manifest_path: OnceLock::new(),
        })
    }
}

#[derive(Debug)]
pub struct DynamicPlugin {
    workspace: PathBuf,
    manifest: PluginManifest,
    runtimes: BTreeMap<String, Runtime>,
    creator_workspace: Option<PathBuf>,
    manifest_path: OnceLock<PathBuf>,
}

impl DynamicPlugin {
    pub async fn script_report(
        &self,
        tool: &str,
        arguments: Value,
    ) -> Result<crate::ScriptExecution, PluginError> {
        let runtime = self
            .runtimes
            .get(tool)
            .ok_or_else(|| PluginError::Invalid(format!("unknown tool export: {tool}")))?;
        runtime
            .script_report(&self.workspace, tool, arguments)
            .await
    }
}

#[async_trait]
impl Plugin for DynamicPlugin {
    fn manifest(&self) -> &PluginManifest {
        &self.manifest
    }

    fn manifest_path(&self) -> Option<&Path> {
        self.manifest_path.get().map(PathBuf::as_path)
    }

    async fn invoke(&self, tool: &str, arguments: Value) -> Result<Value, PluginError> {
        let runtime = self
            .runtimes
            .get(tool)
            .ok_or_else(|| PluginError::Invalid(format!("unknown tool export: {tool}")))?;
        runtime.invoke(&self.workspace, tool, arguments).await
    }
}

fn extension(path: &Path) -> Option<&str> {
    path.extension().and_then(std::ffi::OsStr::to_str)
}

fn read_manifest(directory: &Dir, path: &Path) -> Result<PluginManifest, PluginError> {
    let bytes = read_file(directory, path, MAX_MANIFEST_BYTES)?;
    match extension(path) {
        Some("json") => {
            serde_json::from_slice(&bytes).map_err(|error| PluginError::Invalid(error.to_string()))
        }
        _ => serde_yaml_ng::from_slice(&bytes)
            .map_err(|error| PluginError::Invalid(error.to_string())),
    }
}

fn read_file(dir: &Dir, path: &Path, limit: usize) -> Result<Vec<u8>, PluginError> {
    if !dir.metadata(path)?.is_file() {
        return Err(PluginError::Invalid(format!(
            "not a regular file: {}",
            path.display()
        )));
    }
    let mut bytes = Vec::new();
    dir.open(path)?
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return Err(PluginError::Invalid(format!(
            "{} exceeds {limit} bytes",
            path.display()
        )));
    }
    Ok(bytes)
}

fn create_directory(parent: &Dir, name: &str) -> Result<Dir, PluginError> {
    match parent.create_dir(name) {
        Ok(()) => (),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => (),
        Err(e) => return Err(e.into()),
    }
    if !parent.symlink_metadata(name)?.is_dir() {
        return Err(PluginError::Invalid(format!(
            "{name} must be a directory, not a symlink"
        )));
    }
    Ok(parent.open_dir(name)?)
}

fn write_new(parent: &Dir, path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = parent.open_with(
        path,
        cap_std::fs::OpenOptions::new().write(true).create_new(true),
    )?;
    if let Err(e) = file.write_all(bytes) {
        drop(file);
        let _ = parent.remove_file(path);
        return Err(e);
    }
    Ok(())
}

fn publish_manifest(parent: &Dir, path: &Path, bytes: &[u8]) -> io::Result<()> {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let staging = format!(
        ".manifest-{}-{}.tmp",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    write_new(parent, Path::new(&staging), bytes)?;
    // Discovery must not see a partial manifest, and two sessions may publish the same name.
    let result = parent.hard_link(&staging, parent, path);
    let _ = parent.remove_file(staging);
    result
}

fn manifest_bytes(manifest: &PluginManifest) -> Result<Vec<u8>, PluginError> {
    let bytes =
        serde_json::to_vec_pretty(manifest).map_err(|e| PluginError::Invalid(e.to_string()))?;
    if bytes.len() > MAX_MANIFEST_BYTES {
        return Err(PluginError::Invalid(format!(
            "manifest exceeds {MAX_MANIFEST_BYTES} bytes"
        )));
    }
    Ok(bytes)
}
