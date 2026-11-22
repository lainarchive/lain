use std::{
    error::Error,
    process::Command,
    sync::{Arc, Mutex},
};

use async_trait::async_trait;
use futures::{stream, stream::BoxStream};
use lain_core::{
    provider::{
        CompletionRequest, CompletionResponse, Message, ModelProvider, Role, Token, ToolCall,
    },
    CoreError,
};
use lain_harness::{
    abort::{run_turn, Rule, StreamWatcher, Verdict},
    advisor::{spawn_advisor, Advisor, AdvisorKind, AdvisorModel, AdvisorNote},
    cache::FrozenTranscript,
    dag::{Dag, Node},
    evidence::{Evidence, Status, StepReport},
    scope::{ScopeGuard, WriteScope},
    verify::{verify_with_repair, MAX_REPAIR_PASSES},
    worktree::Worktree,
};
use regex::Regex;
use serde_json::json;

type TestResult = Result<(), Box<dyn Error>>;

fn observation(code: i32) -> Evidence {
    Evidence::TestRun {
        command: "cargo test".into(),
        exit_code: code,
        output_tail: None,
    }
}

#[test]
fn evidence_cannot_skip_or_fake_verification() -> TestResult {
    let mut report = StepReport::new("test", "Only the named test; no live provider exercised");
    assert_eq!(report.status(), Status::Planned);
    assert!(report.verify(vec![observation(0)]).is_err());
    assert_eq!(report.status(), Status::Planned);
    report.prepare()?;
    assert!(report.prepare().is_err());
    assert!(report.verify(vec![]).is_err());
    assert!(report.verify(vec![observation(0), observation(1)]).is_err());
    assert_eq!(report.status(), Status::PreparedNotObserved);
    assert!(!report.is_done());
    report.verify(vec![observation(0)])?;
    assert!(report.is_done());
    assert!(report.verify(vec![observation(0)]).is_err());
    assert_eq!(
        serde_json::to_value(&report)?
            .get("status")
            .and_then(serde_json::Value::as_str),
        Some("observed_verified")
    );
    assert_eq!(
        serde_json::to_value(Status::PreparedNotObserved)?,
        "prepared_not_observed"
    );
    Ok(())
}

fn node(
    root: &std::path::Path,
    id: &str,
    deps: &[&str],
    paths: &[&str],
) -> Result<Node, Box<dyn Error>> {
    Ok(Node {
        id: id.into(),
        deps: deps.iter().map(|s| (*s).into()).collect(),
        write_scope: WriteScope::new(root, paths)?,
    })
}

#[test]
fn dag_checks_scopes_dependencies_and_layers() -> TestResult {
    let root = tempfile::tempdir()?;
    assert!(WriteScope::new(root.path(), ["../escape"]).is_err());
    assert!(WriteScope::new(root.path(), ["a/../../escape"]).is_err());
    assert!(WriteScope::new(root.path(), [root.path().join("../escape")]).is_err());
    let scope = WriteScope::new(root.path(), ["src/./nested/../lib"])?;
    assert!(scope.contains("src/lib/a.rs"));
    assert!(!scope.contains("src/library/a.rs"));
    assert!(!scope.contains("../escape"));
    assert!(scope.contains(root.path().join("src/lib/a.rs")));
    assert!(Dag::new(vec![
        node(root.path(), "a", &[], &["src"])?,
        node(root.path(), "b", &[], &["src/lib"])?
    ])
    .is_err());
    assert!(Dag::new(vec![node(root.path(), "a", &["missing"], &[])?]).is_err());
    assert!(Dag::new(vec![
        node(root.path(), "a", &["b"], &[])?,
        node(root.path(), "b", &["a"], &[])?
    ])
    .is_err());
    assert!(Dag::new(vec![
        node(root.path(), "a", &[], &[])?,
        node(root.path(), "a", &[], &[])?
    ])
    .is_err());
    let dag = Dag::new(vec![
        node(root.path(), "a", &[], &["src"])?,
        node(root.path(), "b", &["a"], &["src/lib"])?,
        node(root.path(), "c", &["b"], &["src"])?,
    ])?;
    let layers: Vec<Vec<&str>> = dag
        .layers()
        .iter()
        .map(|layer| layer.iter().map(|n| n.id.as_str()).collect())
        .collect();
    assert_eq!(layers, vec![vec!["a"], vec!["b"], vec!["c"]]);
    assert!(Dag::new(vec![])?.layers().is_empty());
    Ok(())
}

#[test]
fn scope_guard_fails_closed_for_executors_and_unbounded_targets() -> TestResult {
    let root = tempfile::tempdir()?;
    let dag = Dag::new(vec![
        node(root.path(), "a", &[], &["src"])?,
        node(root.path(), "reader", &[], &[])?,
    ])?;
    let guard = ScopeGuard::new(
        &dag,
        |name| name == "read_file",
        |name| name == "write_file",
    );
    let call = |name: &str, args| ToolCall {
        id: "1".into(),
        name: name.into(),
        arguments: args,
    };
    assert!(guard
        .check("a", &call("write_file", json!({"path":"src/a.rs"})))
        .is_ok());
    assert!(guard
        .check("a", &call("write_file", json!({"file_path":"src/a.rs"})))
        .is_ok());
    for args in [
        json!({"path":"elsewhere"}),
        json!({"path":"../escape"}),
        json!({}),
        json!({"path":42}),
        json!({"path":"src/a", "file_path":"elsewhere"}),
    ] {
        assert!(guard.check("a", &call("write_file", args)).is_err());
    }
    for name in [
        "bash",
        "powershell",
        "create_tool",
        "test_tool",
        "unknown_plugin",
    ] {
        assert!(guard
            .check("a", &call(name, json!({"path":"src/okay"})))
            .is_err());
    }
    assert!(guard
        .check("a", &call("read_file", json!({"path":"elsewhere"})))
        .is_ok());
    assert!(guard
        .check("missing", &call("read_file", json!({})))
        .is_err());
    assert!(guard
        .check("reader", &call("write_file", json!({"path":"src/a"})))
        .is_err());
    Ok(())
}

#[tokio::test]
async fn repair_is_bounded_and_rechecks_after_each_pass() {
    let repairs = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counted = repairs.clone();
    let (report, passes) = verify_with_repair(
        "verify",
        "unit tests only",
        || async { vec![observation(1)] },
        move |_| {
            counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            async {}
        },
    )
    .await;
    assert_eq!(passes, MAX_REPAIR_PASSES);
    assert_eq!(repairs.load(std::sync::atomic::Ordering::SeqCst), 2);
    assert_eq!(report.status(), Status::PreparedNotObserved);
    assert!(report.claim_boundary().contains("repair budget exhausted"));
    assert_eq!(report.evidence().len(), 1);
    let mut checks = 0;
    let (report, passes) = verify_with_repair(
        "verify",
        "compiler only",
        || {
            checks += 1;
            let code = if checks == 1 { 1 } else { 0 };
            async move { vec![observation(code)] }
        },
        |_| async {},
    )
    .await;
    assert!(report.is_done());
    assert_eq!(passes, 1);
    let (report, passes) =
        verify_with_repair("verify", "empty", || async { vec![] }, |_| async {}).await;
    assert!(!report.is_done());
    assert_eq!(passes, 2);
    let (report, passes) = verify_with_repair(
        "verify",
        "tests",
        || async { vec![observation(0)] },
        |_| async {},
    )
    .await;
    assert!(report.is_done());
    assert_eq!(passes, 0);
}

fn watcher() -> Result<StreamWatcher, regex::Error> {
    Ok(StreamWatcher::new(vec![Rule {
        name: "credential".into(),
        pattern: Regex::new("SECRET")?,
        correction: "Do not emit credentials".into(),
    }]))
}

#[test]
fn watcher_matches_across_tokens_and_keeps_only_safe_prefix() -> TestResult {
    let mut watch = watcher()?;
    assert_eq!(watch.push("safe SE"), Verdict::Continue);
    assert_eq!(
        watch.push("CRET trailing"),
        Verdict::Abort {
            rule: "credential".into(),
            correction: "Do not emit credentials".into(),
            keep: "safe ".into()
        }
    );
    watch.reset();
    assert_eq!(watch.push("okay"), Verdict::Continue);
    assert_eq!(watch.text(), "okay");
    assert_eq!(
        StreamWatcher::new(vec![]).push("anything"),
        Verdict::Continue
    );
    Ok(())
}

#[derive(Debug)]
struct FakeProvider {
    requests: Mutex<Vec<CompletionRequest>>,
    always_abort: bool,
    fail: bool,
}

#[async_trait]
impl ModelProvider for FakeProvider {
    async fn complete(&self, _: CompletionRequest) -> Result<CompletionResponse, CoreError> {
        Err(CoreError::Protocol("stream-only fake".into()))
    }
    async fn stream(
        &self,
        req: CompletionRequest,
    ) -> Result<BoxStream<'static, Result<Token, CoreError>>, CoreError> {
        let mut requests = self
            .requests
            .lock()
            .map_err(|e| CoreError::Protocol(e.to_string()))?;
        requests.push(req);
        let tokens = if self.fail {
            vec![Err(CoreError::Protocol("broken stream".into()))]
        } else if self.always_abort || requests.len() == 1 {
            vec![
                Ok(Token::Text("safe SE".into())),
                Ok(Token::Text("CRET".into())),
                Err(CoreError::Protocol("must drop before reading this".into())),
            ]
        } else {
            vec![
                Ok(Token::Text("corrected".into())),
                Ok(Token::Finished("stop".into())),
            ]
        };
        Ok(Box::pin(stream::iter(tokens)))
    }
}

fn request() -> CompletionRequest {
    CompletionRequest {
        model: "fake".into(),
        messages: vec![Message::text(Role::User, "hello")],
        tools: vec![],
        temperature: None,
        max_tokens: None,
    }
}

#[tokio::test]
async fn abort_driver_restarts_with_system_correction_and_bounds_restarts() -> TestResult {
    let provider = FakeProvider {
        requests: Mutex::new(vec![]),
        always_abort: false,
        fail: false,
    };
    assert_eq!(
        run_turn(&provider, request(), &mut watcher()?, 1).await?,
        "corrected"
    );
    {
        let requests = provider.requests.lock().map_err(|e| e.to_string())?;
        let second = requests.get(1).ok_or("missing restart")?;
        assert!(second
            .messages
            .last()
            .is_some_and(|m| m.role == Role::System
                && m.content.as_deref() == Some("Do not emit credentials")));
    }
    let provider = FakeProvider {
        requests: Mutex::new(vec![]),
        always_abort: true,
        fail: false,
    };
    assert!(run_turn(&provider, request(), &mut watcher()?, 2)
        .await
        .is_err());
    assert_eq!(
        provider.requests.lock().map_err(|e| e.to_string())?.len(),
        3
    );
    let provider = FakeProvider {
        requests: Mutex::new(vec![]),
        always_abort: false,
        fail: true,
    };
    assert!(run_turn(&provider, request(), &mut watcher()?, 2)
        .await
        .is_err());
    Ok(())
}

#[test]
fn frozen_prefix_survives_tool_completion_and_later_turns() -> TestResult {
    let mut transcript = FrozenTranscript::default();
    assert!(transcript.prefix_bytes().is_empty());
    transcript.push(Message::text(Role::User, "hello"));
    transcript.commit()?;
    let prefix = transcript.prefix_bytes().to_vec();
    let mut assistant = Message::text(Role::Assistant, "checking");
    assistant.tool_calls.push(ToolCall {
        id: "tool-1".into(),
        name: "read".into(),
        arguments: json!({}),
    });
    transcript.push(assistant);
    assert_eq!(transcript.prefix_bytes(), prefix);
    assert!(transcript.commit().is_err());
    transcript.complete_tool("tool-1", "result")?;
    assert!(transcript.complete_tool("missing", "bad").is_err());
    assert!(transcript.complete_tool("tool-1", "duplicate").is_err());
    transcript.commit()?;
    assert!(transcript.prefix_bytes().starts_with(&prefix));
    let prefix = transcript.prefix_bytes().to_vec();
    transcript.push(Message::text(Role::User, "next"));
    transcript.commit()?;
    assert!(transcript.prefix_bytes().starts_with(&prefix));
    assert_eq!(transcript.messages().len(), 4);
    assert!(transcript
        .messages()
        .get(2)
        .is_some_and(|m| m.role == Role::Tool && m.tool_call_id.as_deref() == Some("tool-1")));
    Ok(())
}

#[derive(Debug)]
struct Reviewer;
impl AdvisorModel for Reviewer {
    async fn review(&self, text: &str) -> Vec<AdvisorNote> {
        vec![AdvisorNote {
            kind: AdvisorKind::Aside,
            turn: 0,
            text: text.into(),
        }]
    }
}

#[tokio::test]
async fn advisor_drops_instead_of_blocking() -> TestResult {
    let (advisor, mut notes) = Advisor::channel(1)?;
    advisor.observe(AdvisorNote {
        kind: AdvisorKind::Warning,
        turn: 1,
        text: "first".into(),
    });
    advisor.observe(AdvisorNote {
        kind: AdvisorKind::Blocker,
        turn: 2,
        text: "dropped".into(),
    });
    assert_eq!(advisor.dropped(), 1);
    assert!(notes.recv().await.is_some_and(|n| n.turn == 1));
    drop(notes);
    advisor.observe(AdvisorNote {
        kind: AdvisorKind::Aside,
        turn: 3,
        text: "closed".into(),
    });
    assert_eq!(advisor.dropped(), 2);
    assert!(Advisor::channel(0).is_err());
    assert!(Advisor::channel(usize::MAX).is_err());
    let (advisor, mut notes) = Advisor::channel(1)?;
    spawn_advisor(Arc::new(Reviewer), advisor, 7, "review this".into()).await?;
    assert!(notes
        .recv()
        .await
        .is_some_and(|n| n.turn == 7 && n.text == "review this"));
    Ok(())
}

#[test]
fn detached_worktrees_are_outside_active_tree_and_cleaned_up() -> TestResult {
    let repo = tempfile::tempdir()?;
    for args in [
        vec!["init"],
        vec![
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "--allow-empty",
            "-m",
            "initial",
        ],
    ] {
        let output = Command::new("git")
            .args(args)
            .current_dir(repo.path())
            .output()?;
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    assert!(Worktree::detached(repo.path(), "../escape").is_err());
    let mut tree = Worktree::detached(repo.path(), "lane-a")?;
    let path = tree.path().to_path_buf();
    assert!(
        std::fs::canonicalize(&path)?.starts_with(std::fs::canonicalize(repo.path().join(".git"))?)
    );
    assert!(path.join(".git").is_file());
    assert!(tree.branch_label().starts_with("detached@"));
    assert!(Worktree::detached(repo.path(), "lane-a").is_err());
    tree.remove()?;
    tree.remove()?;
    assert!(!path.exists());
    let path = {
        let tree = Worktree::detached(repo.path(), "lane-b")?;
        tree.path().to_path_buf()
    };
    assert!(!path.exists());
    Ok(())
}
