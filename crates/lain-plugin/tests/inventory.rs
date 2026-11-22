use std::{fs, path::Path};

use lain_plugin::{
    manifest::{ScriptInterpreter, HOST_PROCESS_PERMISSIONS},
    Plugin, PluginManager,
};
use serde_json::json;

fn manifest(name: &str) -> serde_json::Value {
    json!({
        "name":name, "version":"1.2.3", "author":"inventory tests", "permissions":["network"],
        "tools":[{"name":format!("{name}_export"), "description":"Inventory fixture", "parameters":{"type":"object"},
            "backend":{"kind":"webhook", "url":"http://127.0.0.1:9/unused"}}]
    })
}

#[test]
fn inventory_keeps_each_parse_result_without_loading_plugins(
) -> Result<(), Box<dyn std::error::Error>> {
    let workspace = tempfile::tempdir()?;
    let plugins = workspace.path().join(".lain/plugins");
    let tools = workspace.path().join(".lain/tools");
    fs::create_dir_all(&plugins)?;
    fs::create_dir_all(&tools)?;
    fs::write(
        plugins.join("a-package.json"),
        manifest("first").to_string(),
    )?;
    fs::write(plugins.join("b-broken.yaml"), "name: [unfinished")?;
    fs::write(plugins.join("c-too-large.json"), " ".repeat(64 * 1024 + 1))?;
    fs::write(plugins.join("ignored.txt"), "not a manifest")?;
    fs::create_dir(plugins.join("directory.json"))?;
    fs::write(
        tools.join("z-tool.yml"),
        serde_json::to_string(&manifest("last"))?,
    )?;
    let manager = PluginManager::new(workspace.path(), Default::default());
    let entries = manager.inventory()?;
    assert_eq!(
        entries
            .iter()
            .map(|entry| entry.path.clone())
            .collect::<Vec<_>>(),
        [
            ".lain/plugins/a-package.json",
            ".lain/plugins/b-broken.yaml",
            ".lain/plugins/c-too-large.json",
            ".lain/tools/z-tool.yml"
        ]
        .map(std::path::PathBuf::from)
    );
    assert_eq!(
        entries
            .first()
            .ok_or("missing first entry")?
            .manifest
            .as_ref()
            .map(|m| m.name.as_str()),
        Ok("first")
    );
    assert!(entries
        .get(1)
        .ok_or("missing parse error")?
        .manifest
        .is_err());
    assert!(entries
        .get(2)
        .ok_or("missing size error")?
        .manifest
        .as_ref()
        .is_err_and(|e| e.contains("exceeds")));
    assert_eq!(
        entries
            .last()
            .ok_or("missing last entry")?
            .manifest
            .as_ref()
            .map(|m| m.name.as_str()),
        Ok("last")
    );
    assert!(manager.discover()?.is_empty());
    let enabled = PluginManager::new(
        workspace.path(),
        HOST_PROCESS_PERMISSIONS.into_iter().collect(),
    );
    assert!(enabled
        .discover()
        .unwrap_err()
        .to_string()
        .contains("b-broken.yaml"));
    assert_eq!(enabled.inventory()?.len(), entries.len());
    let restored: Vec<lain_plugin::ManifestEntry> =
        serde_json::from_str(&serde_json::to_string(&entries)?)?;
    assert_eq!(
        serde_json::to_value(restored)?,
        serde_json::to_value(entries)?
    );
    Ok(())
}

#[test]
fn inventory_does_not_read_missing_script_backends() -> Result<(), Box<dyn std::error::Error>> {
    let workspace = tempfile::tempdir()?;
    let directory = workspace.path().join(".lain/tools");
    fs::create_dir_all(&directory)?;
    fs::write(directory.join("template.json"), json!({
        "name":"template", "version":"1", "author":"test", "permissions":["read_fs","write_fs","network","subprocess"],
        "tools":[{"name":"template", "description":"Missing source", "parameters":{"type":"object"},
            "backend":{"kind":"script", "interpreter":"python", "path":"missing.py"}}]
    }).to_string())?;
    let manager = PluginManager::new(
        workspace.path(),
        HOST_PROCESS_PERMISSIONS.into_iter().collect(),
    );
    let entries = manager.inventory()?;
    assert!(entries.first().ok_or("missing template")?.manifest.is_ok());
    assert!(manager.discover().is_err());
    assert!(!directory.join("missing.py").exists());
    Ok(())
}

#[test]
fn inventory_empty_and_directory_errors() -> Result<(), Box<dyn std::error::Error>> {
    let workspace = tempfile::tempdir()?;
    let manager = PluginManager::new(
        workspace.path(),
        HOST_PROCESS_PERMISSIONS.into_iter().collect(),
    );
    assert!(manager.inventory()?.is_empty());
    assert!(manager.discover()?.is_empty());
    fs::create_dir(workspace.path().join(".lain"))?;
    fs::write(workspace.path().join(".lain/plugins"), "not a directory")?;
    assert!(manager.inventory().is_err());
    assert!(manager.discover().is_err());
    Ok(())
}

#[test]
fn loaded_and_persisted_plugins_keep_manifest_paths() -> Result<(), Box<dyn std::error::Error>> {
    let workspace = tempfile::tempdir()?;
    let directory = workspace.path().join(".lain/plugins");
    fs::create_dir_all(&directory)?;
    fs::write(
        directory.join("different-file-name.json"),
        manifest("package_name").to_string(),
    )?;
    let manager = PluginManager::new(
        workspace.path(),
        HOST_PROCESS_PERMISSIONS.into_iter().collect(),
    );
    let loaded = manager.discover()?;
    let plugin = loaded.first().ok_or("missing loaded plugin")?;
    assert_eq!(plugin.manifest().name, "package_name");
    assert_eq!(
        plugin.manifest_path(),
        Some(Path::new(".lain/plugins/different-file-name.json"))
    );
    let proposal = || {
        manager.prepare_script(
            "created".into(),
            "Created fixture".into(),
            json!({"type":"object"}),
            ScriptInterpreter::Python,
            "pass".into(),
        )
    };
    let created = proposal()?;
    assert_eq!(created.manifest_path(), None);
    manager.persist_script(&created)?;
    assert_eq!(
        created.manifest_path(),
        Some(Path::new(".lain/tools/tool-created.json"))
    );
    let collision = proposal()?;
    assert!(manager.persist_script(&collision).is_err());
    assert_eq!(collision.manifest_path(), None);
    let blocked = manager.prepare_script(
        "blocked".into(),
        "Blocked fixture".into(),
        json!({"type":"object"}),
        ScriptInterpreter::Python,
        "pass".into(),
    )?;
    fs::write(
        workspace.path().join(".lain/tools/tool-blocked.json"),
        "occupied",
    )?;
    assert!(manager.persist_script(&blocked).is_err());
    assert_eq!(blocked.manifest_path(), None);
    assert!(!workspace
        .path()
        .join(".lain/tools/tool-blocked.py")
        .exists());
    Ok(())
}

#[cfg(unix)]
#[test]
fn inventory_skips_symlinks_like_discovery() -> Result<(), Box<dyn std::error::Error>> {
    let workspace = tempfile::tempdir()?;
    let outside = tempfile::tempdir()?;
    let directory = workspace.path().join(".lain/plugins");
    fs::create_dir_all(&directory)?;
    fs::write(
        outside.path().join("outside.json"),
        manifest("outside").to_string(),
    )?;
    std::os::unix::fs::symlink(
        outside.path().join("outside.json"),
        directory.join("link.json"),
    )?;
    let manager = PluginManager::new(
        workspace.path(),
        HOST_PROCESS_PERMISSIONS.into_iter().collect(),
    );
    assert!(manager.inventory()?.is_empty());
    assert!(manager.discover()?.is_empty());
    Ok(())
}
