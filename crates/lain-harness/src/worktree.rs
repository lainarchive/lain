use std::{
    path::{Path, PathBuf},
    process::Command,
};

#[derive(Debug, thiserror::Error)]
pub enum WorktreeError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("git worktree: {0}")]
    Git(String),
}

fn git(repo: &Path, args: &[&std::ffi::OsStr]) -> Result<String, WorktreeError> {
    let output = Command::new("git").current_dir(repo).args(args).output()?;
    if !output.status.success() {
        return Err(WorktreeError::Git(
            String::from_utf8_lossy(&output.stderr).trim().into(),
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().into())
}

#[derive(Debug)]
pub struct Worktree {
    repo: PathBuf,
    path: PathBuf,
    branch_label: String,
    removed: bool,
}

impl Worktree {
    pub fn detached(repo: impl AsRef<Path>, name: &str) -> Result<Self, WorktreeError> {
        if name.is_empty()
            || name.len() > 64
            || !name
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        {
            return Err(WorktreeError::Git(
                "name must contain 1..64 ASCII letters, digits, hyphens or underscores".into(),
            ));
        }
        let repo = std::fs::canonicalize(repo)?;
        let common = git(
            &repo,
            &[
                "rev-parse".as_ref(),
                "--path-format=absolute".as_ref(),
                "--git-common-dir".as_ref(),
            ],
        )?;
        let parent = Path::new(&common).join("lain-harness-worktrees");
        std::fs::create_dir_all(&parent)?;
        let path = parent.join(name);
        git(
            &repo,
            &[
                "worktree".as_ref(),
                "add".as_ref(),
                "--detach".as_ref(),
                path.as_os_str(),
                "HEAD".as_ref(),
            ],
        )?;
        let mut tree = Self {
            repo,
            path,
            branch_label: String::new(),
            removed: false,
        };
        let sha = git(
            &tree.path,
            &["rev-parse".as_ref(), "--short".as_ref(), "HEAD".as_ref()],
        )?;
        tree.branch_label = format!("detached@{sha}");
        Ok(tree)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
    pub fn branch_label(&self) -> &str {
        &self.branch_label
    }

    pub fn remove(&mut self) -> Result<(), WorktreeError> {
        if !self.removed {
            git(
                &self.repo,
                &[
                    "worktree".as_ref(),
                    "remove".as_ref(),
                    "--force".as_ref(),
                    self.path.as_os_str(),
                ],
            )?;
            self.removed = true;
        }
        Ok(())
    }
}

impl Drop for Worktree {
    fn drop(&mut self) {
        let _ = self.remove();
    }
}
