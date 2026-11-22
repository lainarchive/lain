use std::path::{Component, Path, PathBuf};

use lain_core::provider::ToolCall;

use crate::dag::Dag;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("scope violation: {0}")]
pub struct ScopeViolation(pub String);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteScope {
    root: PathBuf,
    paths: Vec<PathBuf>,
}

fn normalize(path: &Path) -> Result<PathBuf, ScopeViolation> {
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !matches!(result.components().next_back(), Some(Component::Normal(_)))
                    || !result.pop()
                {
                    return Err(ScopeViolation(format!(
                        "path escapes root: {}",
                        path.display()
                    )));
                }
            }
            other => result.push(other.as_os_str()),
        }
    }
    Ok(result)
}

impl WriteScope {
    pub fn new<P: AsRef<Path>>(
        root: impl AsRef<Path>,
        paths: impl IntoIterator<Item = P>,
    ) -> Result<Self, ScopeViolation> {
        let root = root.as_ref();
        if !root.is_absolute() {
            return Err(ScopeViolation("workspace root must be absolute".into()));
        }
        let mut scope = Self {
            root: normalize(root)?,
            paths: vec![],
        };
        for path in paths {
            scope.paths.push(scope.relative(path.as_ref())?);
        }
        Ok(scope)
    }

    fn relative(&self, path: &Path) -> Result<PathBuf, ScopeViolation> {
        // I refuse foreign separators and drive prefixes rather than reinterpret them differently on another host.
        if cfg!(unix)
            && (path.to_string_lossy().contains('\\') || path.to_string_lossy().contains(':'))
        {
            return Err(ScopeViolation("foreign path syntax".into()));
        }
        let relative = if path.is_absolute() {
            path.strip_prefix(&self.root)
                .map_err(|_| ScopeViolation("absolute path outside workspace".into()))?
        } else {
            path
        };
        let normalized = normalize(relative)?;
        if normalized
            .components()
            .any(|c| matches!(c, Component::Prefix(_) | Component::RootDir))
        {
            return Err(ScopeViolation("absolute scope".into()));
        }
        Ok(normalized)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn paths(&self) -> &[PathBuf] {
        &self.paths
    }

    pub fn contains(&self, path: impl AsRef<Path>) -> bool {
        self.relative(path.as_ref())
            .is_ok_and(|target| self.paths.iter().any(|scope| target.starts_with(scope)))
    }

    pub fn overlaps(&self, other: &Self) -> bool {
        self.paths.iter().any(|a| {
            other.paths.iter().any(|b| {
                let a = self.root.join(a);
                let b = other.root.join(b);
                a.starts_with(&b) || b.starts_with(&a)
            })
        })
    }
}

pub struct ScopeGuard<'a, R, W> {
    dag: &'a Dag,
    read_only: R,
    path_writer: W,
}

impl<R, W> std::fmt::Debug for ScopeGuard<'_, R, W> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ScopeGuard")
            .field("dag", &self.dag)
            .finish_non_exhaustive()
    }
}

impl<'a, R: Fn(&str) -> bool, W: Fn(&str) -> bool> ScopeGuard<'a, R, W> {
    pub fn new(dag: &'a Dag, read_only: R, path_writer: W) -> Self {
        Self {
            dag,
            read_only,
            path_writer,
        }
    }

    pub fn check(&self, node_id: &str, call: &ToolCall) -> Result<(), ScopeViolation> {
        let node = self
            .dag
            .node(node_id)
            .ok_or_else(|| ScopeViolation(format!("unknown node: {node_id}")))?;
        if matches!(
            call.name.as_str(),
            "bash" | "powershell" | "create_tool" | "test_tool"
        ) {
            return Err(ScopeViolation(format!("unbounded executor: {}", call.name)));
        }
        if (self.read_only)(&call.name) {
            return Ok(());
        }
        if !(self.path_writer)(&call.name) {
            return Err(ScopeViolation(format!("unclassified tool: {}", call.name)));
        }
        let mut targets = 0;
        for key in ["path", "file_path"] {
            if let Some(value) = call.arguments.get(key) {
                targets += 1;
                let path = value
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| ScopeViolation(format!("invalid {key}")))?;
                if !node.write_scope.contains(path) {
                    return Err(ScopeViolation(format!("outside {}: {path}", node.id)));
                }
            }
        }
        if targets == 0 {
            return Err(ScopeViolation("missing path/file_path".into()));
        }
        Ok(())
    }
}
