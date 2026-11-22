use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use lain_core::tools::{MemoryReadTool, ToolRegistry, ToolSource};
use lain_memory::MemoryStore;
use lain_plugin::{PluginManager, manifest::HOST_PROCESS_PERMISSIONS};
use serde_json::json;

#[test]
fn registered_tools_keep_source_without_rescanning_disk() -> Result<(), Box<dyn std::error::Error>>
{
    let workspace = tempfile::tempdir()?;
    let directory = workspace.path().join(".lain/plugins");
    fs::create_dir_all(&directory)?;
    let path = directory.join("original-file.json");
    fs::write(&path, json!({
        "name":"package_name", "version":"1", "author":"test", "permissions":["network"],
        "tools":[{"name":"different_export", "description":"Source fixture", "parameters":{"type":"object"},
            "backend":{"kind":"webhook", "url":"http://127.0.0.1:9/unused"}},
            {"name":"second_export", "description":"Another export", "parameters":{"type":"object"},
            "backend":{"kind":"webhook", "url":"http://127.0.0.1:9/unused"}}]
    }).to_string())?;
    let mut registry = ToolRegistry::new();
    registry.register(Arc::new(MemoryReadTool::new(Arc::new(Mutex::new(
        MemoryStore::open(":memory:")?,
    )))))?;
    assert_eq!(registry.source("memory_read"), Some(ToolSource::Builtin));
    assert_eq!(registry.source("missing"), None);
    let manager = PluginManager::new(
        workspace.path(),
        HOST_PROCESS_PERMISSIONS.into_iter().collect(),
    );
    registry.register_plugins(&manager)?;
    fs::remove_file(path)?;
    let source = registry
        .source("different_export")
        .ok_or("missing source")?;
    assert_eq!(registry.source("second_export"), Some(source.clone()));
    assert_eq!(
        source,
        ToolSource::Plugin {
            manifest_name: "package_name".into(),
            manifest_path: Some(PathBuf::from(".lain/plugins/original-file.json"))
        }
    );
    assert_eq!(
        serde_json::from_value::<ToolSource>(serde_json::to_value(&source)?)?,
        source
    );
    assert!(registry.is_builtin_read_only("memory_read"));
    assert!(!registry.is_builtin_read_only("different_export"));
    Ok(())
}
