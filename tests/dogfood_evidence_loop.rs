use std::{
    collections::VecDeque,
    error::Error,
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Instant,
};

use async_trait::async_trait;
use futures::stream::BoxStream;
use lain_agent::{AgentConfig, AgentEvent, AgentRunner, ProviderSelection, ToolOutcome};
use lain_context::RepoMap;
use lain_core::{
    CoreError,
    provider::{
        CompletionRequest, CompletionResponse, Message, ModelProvider, Role, Token, ToolCall,
    },
    tools::{Tool, ToolError, ToolOutput, ToolRegistry},
};
use lain_harness::{
    dag::{Dag, Node},
    evidence::{Evidence, Status, StepReport},
    scope::{ScopeGuard, WriteScope},
    worktree::Worktree,
};
use lain_memory::MemoryStore;
use serde_json::{Value, json};

const BUGGY: &str = r#"// fn add(a: i32, b: i32) -> i32 { fake() }

pub fn add(a: i32, b: i32) -> i32 { a - b }

#[cfg(test)]
mod tests {
    #[test]
    fn add_returns_sum() { assert_eq!(super::add(2, 3), 5); }
}
"#;
const MANIFEST: &str =
    "[package]\nname = \"dogfood-add\"\nversion = \"0.1.0\"\nedition = \"2021\"\n[workspace]\n";

fn git(root: &Path, args: &[&str]) -> Result<String, Box<dyn Error>> {
    let output = Command::new("git")
        .current_dir(root)
        .args([
            "-c",
            "user.name=Dogfood",
            "-c",
            "user.email=dogfood@example.invalid",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .output()?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into_owned().into());
    }
    Ok(String::from_utf8(output.stdout)?.trim().into())
}

fn cargo_test(root: &Path, target: &Path) -> Result<(Output, Evidence), Box<dyn Error>> {
    let output = Command::new("cargo")
        .current_dir(root)
        .args(["test", "--offline", "--lib", "--color", "never"])
        .env("CARGO_TARGET_DIR", target)
        .env("CARGO_TERM_COLOR", "never")
        .output()?;
    let exit_code = output
        .status
        .code()
        .ok_or("cargo terminated without an exit code")?;
    let evidence = Evidence::TestRun {
        command: "cargo test --offline --lib --color never".into(),
        exit_code,
        output_tail: Some(format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )),
    };
    Ok((output, evidence))
}

#[derive(Debug)]
struct ScriptedProvider(Mutex<VecDeque<CompletionResponse>>);

#[async_trait]
impl ModelProvider for ScriptedProvider {
    async fn complete(&self, _: CompletionRequest) -> Result<CompletionResponse, CoreError> {
        self.0
            .lock()
            .map_err(|_| CoreError::Protocol("poisoned fixture".into()))?
            .pop_front()
            .ok_or_else(|| CoreError::Protocol("script exhausted".into()))
    }
    async fn stream(
        &self,
        _: CompletionRequest,
    ) -> Result<BoxStream<'static, Result<Token, CoreError>>, CoreError> {
        Err(CoreError::Protocol("offline fixture uses complete".into()))
    }
}

#[derive(Debug)]
struct WriteFile {
    root: PathBuf,
    writes: Arc<AtomicUsize>,
}

#[async_trait]
impl Tool for WriteFile {
    fn name(&self) -> &str {
        "write_file"
    }
    fn description(&self) -> &str {
        "Write a UTF-8 file in the fixture workspace"
    }
    fn parameters_schema(&self) -> Value {
        json!({"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"}},"required":["path","content"],"additionalProperties":false})
    }
    async fn execute(&self, args: Value) -> Result<ToolOutput, ToolError> {
        let path = args
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::Arguments("path".into()))?;
        let content = args
            .get("content")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::Arguments("content".into()))?;
        std::fs::write(self.root.join(path), content)
            .map_err(|e| ToolError::Execution(e.to_string()))?;
        self.writes.fetch_add(1, Ordering::SeqCst);
        Ok(ToolOutput {
            content: "written".into(),
            exit_code: None,
        })
    }
}

#[tokio::test]
async fn lain_fixes_lain_with_observed_evidence() -> Result<(), Box<dyn Error>> {
    let started = Instant::now();
    let temp = tempfile::tempdir()?;
    let repo = temp.path().join("repo");
    std::fs::create_dir(&repo)?;
    std::fs::create_dir(repo.join("src"))?;
    std::fs::write(repo.join(".gitattributes"), "* text eol=lf\n")?;
    std::fs::write(repo.join("Cargo.toml"), MANIFEST)?;
    std::fs::write(repo.join("src/lib.rs"), BUGGY)?;
    git(&repo, &["init", "-b", "main"])?;
    git(
        &repo,
        &["add", ".gitattributes", "Cargo.toml", "src/lib.rs"],
    )?;
    git(&repo, &["commit", "-m", "Seed the broken addition"])?;
    let head = git(&repo, &["rev-parse", "HEAD"])?;
    let map = RepoMap::scan(&repo)?;
    assert!(!map.is_truncated());
    assert!(map.as_str().contains("pub fn add(a: i32, b: i32) -> i32"));
    assert!(!map.as_str().contains("fake()"));
    let source = std::fs::read_to_string(repo.join("src/lib.rs"))?;
    assert_eq!(RepoMap::rust_function_line(&source, "add")?, Some(3));
    assert_eq!(RepoMap::rust_function_line("// fn add() {}", "add")?, None);

    let mut worktree = Worktree::detached(&repo, "add-sign")?;
    let worktree_path = worktree.path().to_path_buf();
    git(&worktree_path, &["switch", "-c", "fix/add-sign"])?;
    assert_eq!(
        git(&worktree_path, &["branch", "--show-current"])?,
        "fix/add-sign"
    );
    let dag = Dag::new(vec![Node {
        id: "fix-add".into(),
        deps: vec![],
        write_scope: WriteScope::new(&worktree_path, ["src/lib.rs"])?,
    }])?;
    let mut report = StepReport::new(
        "fix-add",
        "The isolated dummy crate's real addition unit test passes; no claim about Lain's own correctness",
    );
    assert_eq!(report.status(), Status::Planned);
    assert!(!report.is_done());
    let target = temp.path().join("cargo-target");
    let (before, failed) = cargo_test(&worktree_path, &target)?;
    assert!(!before.status.success());
    assert!(String::from_utf8_lossy(&before.stdout).contains("tests::add_returns_sum ... FAILED"));

    let fixed = BUGGY.replace("{ a - b }", "{ a + b }");
    let calls = [
        ("deny-manifest", "Cargo.toml", "bad manifest"),
        ("deny-parent", "../outside", "bad escape"),
        ("fix-lib", "src/lib.rs", fixed.as_str()),
    ]
    .into_iter()
    .map(|(id, path, content)| ToolCall {
        id: id.into(),
        name: "write_file".into(),
        arguments: json!({"path":path,"content":content}),
    })
    .collect();
    let provider = Arc::new(ScriptedProvider(Mutex::new(VecDeque::from([
        CompletionResponse {
            message: Message {
                role: Role::Assistant,
                content: None,
                tool_calls: calls,
                tool_call_id: None,
            },
            finish_reason: Some("tool_calls".into()),
            usage: None,
        },
        CompletionResponse {
            message: Message::text(
                Role::Assistant,
                "Edited the allowed file; await real test evidence.",
            ),
            finish_reason: Some("stop".into()),
            usage: None,
        },
    ]))));
    let writes = Arc::new(AtomicUsize::new(0));
    let mut tools = ToolRegistry::new();
    tools.register(Arc::new(WriteFile {
        root: worktree_path.clone(),
        writes: writes.clone(),
    }))?;
    let tools = Arc::new(tools);
    let trusted_tools = tools.clone();
    let mut config = AgentConfig::new(
        ProviderSelection::OpenAiCompatible {
            base_url: "http://127.0.0.1:9/v1".into(),
            api_key_env: None,
        },
        "offline-script",
    );
    config.max_turns = 4;
    config.memory_context_limit = 0;
    config.allow_creator_mode = false;
    let mut runner = AgentRunner::new(
        config,
        provider,
        tools,
        Arc::new(Mutex::new(MemoryStore::open(":memory:")?)),
        "dogfood",
    )?;
    runner.set_tool_guard(move |call| {
        ScopeGuard::new(
            &dag,
            |name| trusted_tools.is_builtin_read_only(name),
            |name| name == "write_file",
        )
        .check("fix-add", call)
        .map_err(|e| e.to_string())
    });
    let mut events = runner.subscribe();
    runner.run("Fix add, changing only src/lib.rs").await?;
    let observed: Vec<_> = std::iter::from_fn(|| events.try_recv().ok()).collect();
    for id in ["deny-manifest", "deny-parent"] {
        assert!(observed.iter().any(|event|matches!(event,AgentEvent::ToolCompleted {call_id,outcome:ToolOutcome::Failed {code,..},..} if call_id==id && code=="TOOL_GUARD_DENIED")));
    }
    assert!(observed.iter().any(|event|matches!(event,AgentEvent::ToolCompleted {call_id,outcome:ToolOutcome::Succeeded(_),..} if call_id=="fix-lib")));
    assert_eq!(writes.load(Ordering::SeqCst), 1);
    assert_eq!(
        std::fs::read_to_string(worktree_path.join("Cargo.toml"))?,
        MANIFEST
    );
    assert!(
        !worktree_path
            .parent()
            .ok_or("worktree has no parent")?
            .join("outside")
            .exists()
    );
    assert_eq!(
        std::fs::read_to_string(worktree_path.join("src/lib.rs"))?,
        fixed
    );
    assert_eq!(std::fs::read_to_string(repo.join("src/lib.rs"))?, BUGGY);
    report.prepare()?;
    assert_eq!(report.status(), Status::PreparedNotObserved);
    assert!(report.verify(vec![failed]).is_err());
    assert!(!report.is_done());
    assert_eq!(report.status(), Status::PreparedNotObserved);
    let (after, passed) = cargo_test(&worktree_path, &target)?;
    assert!(
        after.status.success(),
        "{}",
        String::from_utf8_lossy(&after.stderr)
    );
    assert!(String::from_utf8_lossy(&after.stdout).contains("1 passed; 0 failed"));
    report.verify(vec![passed])?;
    assert_eq!(report.status(), Status::ObservedVerified);
    assert!(report.is_done());
    drop(runner);
    worktree.remove()?;
    assert!(!worktree_path.exists());
    assert_eq!(git(&repo, &["rev-parse", "HEAD"])?, head);
    assert_eq!(
        git(&repo, &["worktree", "list", "--porcelain"])?
            .matches("worktree ")
            .count(),
        1
    );
    eprintln!(
        "dogfood: real cargo test failed before, passed after; guard denied 2 writes; elapsed {:?}",
        started.elapsed()
    );
    Ok(())
}
