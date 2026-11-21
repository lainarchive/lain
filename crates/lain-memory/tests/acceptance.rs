use lain_memory::{MemoryInput, MemoryStore, NeighborOptions, SearchOptions};

fn input(id: &str, title: &str, content: &str, source: &str, trusted: bool) -> MemoryInput {
    MemoryInput {
        id: Some(id.into()),
        title: title.into(),
        content: content.into(),
        source: source.into(),
        trust: trusted.then(|| "trusted".into()),
        ..MemoryInput::default()
    }
}
fn store() -> lain_memory::Result<MemoryStore> {
    MemoryStore::open(":memory:")
}
fn all() -> SearchOptions {
    SearchOptions {
        include_untrusted: true,
        ..SearchOptions::default()
    }
}
fn neighbors(depth: i64, include_untrusted: bool) -> NeighborOptions {
    NeighborOptions {
        depth,
        include_untrusted,
    }
}

#[test]
fn at_p4_01_fts5_lexical_retrieval_and_update() {
    let mut s = store().unwrap();
    let mut i = input(
        "trusted",
        "SQLite WAL mode",
        "Use WAL mode for concurrent readers and single writer.",
        "docs/architecture.md",
        true,
    );
    i.kind = Some("decision".into());
    let trusted = s.remember(i).unwrap();
    let untrusted = s
        .remember(input(
            "untrusted",
            "SQLite pragma note",
            "Unverified note mentioning WAL mode.",
            "web:unverified",
            false,
        ))
        .unwrap();
    assert_eq!(trusted.trust, "trusted");
    assert_eq!(untrusted.trust, "untrusted");
    let hits = s.search("WAL mode", SearchOptions::default()).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits.first().unwrap().id, trusted.id);
    assert_eq!(hits.first().unwrap().source, "docs/architecture.md");
    assert!(!hits.first().unwrap().created_at.is_empty());
    assert_eq!(hits.first().unwrap().trust, "trusted");
    assert_eq!(s.search("WAL mode", all()).unwrap().len(), 2);
    let mut i = input(
        "trusted",
        "SQLite journal mode",
        "Switched terminology to journal mode.",
        "docs/architecture.md",
        true,
    );
    i.kind = Some("decision".into());
    s.remember(i).unwrap();
    assert!(
        s.search("WAL", SearchOptions::default())
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        s.search("journal", SearchOptions::default()).unwrap().len(),
        1
    );
}

#[test]
fn at_p4_02_supersede_hides_old_records() {
    let mut s = store().unwrap();
    let mut first = input(
        "v1",
        "Deploy target",
        "Deploy service to staging-us-east.",
        "runbook:v1",
        true,
    );
    first.kind = Some("decision".into());
    s.remember(first).unwrap();
    let mut next = input(
        "v2",
        "Deploy target",
        "Deploy service to prod-us-west.",
        "runbook:v2",
        true,
    );
    next.kind = Some("decision".into());
    let result = s.supersede("v1", next).unwrap();
    assert_eq!(result.superseded.id, "v1");
    assert_eq!(result.superseded.superseded_by.as_deref(), Some("v2"));
    assert_eq!(result.current.superseded_by, None);
    let hits = s
        .search("Deploy service", SearchOptions::default())
        .unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits.first().unwrap().id, "v2");
    assert!(hits.first().unwrap().content.contains("prod-us-west"));
    assert_eq!(
        s.supersede("v1", input("v3", "x", "y", "runbook:v3", false))
            .unwrap_err()
            .code(),
        "ALREADY_SUPERSEDED"
    );
}

#[test]
fn at_p4_03_provenance_tracks_supersede_chain() {
    let mut s = store().unwrap();
    assert!(s.provenance("missing-id").unwrap().is_none());
    let mut first = input(
        "first",
        "Retention window",
        "Keep logs for 14 days.",
        "user:charter",
        true,
    );
    first.kind = Some("preference".into());
    s.remember(first).unwrap();
    let mut next = input(
        "second",
        "Retention window",
        "Keep logs for 30 days.",
        "user:update",
        true,
    );
    next.kind = Some("preference".into());
    s.supersede("first", next).unwrap();
    let p1 = s.provenance("first").unwrap().unwrap();
    assert_eq!(p1.source, "user:charter");
    assert_eq!(p1.trust, "trusted");
    assert!(!p1.created_at.is_empty());
    assert!(!p1.updated_at.is_empty());
    assert_eq!(p1.superseded_by.as_deref(), Some("second"));
    assert!(p1.supersedes.is_empty());
    let p2 = s.provenance("second").unwrap().unwrap();
    assert_eq!(p2.source, "user:update");
    assert_eq!(p2.superseded_by, None);
    assert_eq!(p2.supersedes, vec!["first"]);
}

#[test]
fn at_p4_04_untrusted_requires_explicit_promotion() {
    let mut s = store().unwrap();
    assert_eq!(
        s.remember(input(
            "mem-untrusted",
            "API endpoint",
            "Endpoint is https://internal.example/v1",
            "tool:scrape",
            false
        ))
        .unwrap()
        .trust,
        "untrusted"
    );
    assert_eq!(
        s.remember(input(
            "mem-untrusted",
            "API endpoint",
            "Endpoint is https://internal.example/v2",
            "agent:guess",
            true
        ))
        .unwrap()
        .trust,
        "untrusted"
    );
    let mut i = input(
        "policy",
        "Auth policy",
        "Require mTLS for internal RPC.",
        "security:policy",
        true,
    );
    i.kind = Some("decision".into());
    s.remember(i).unwrap();
    assert_eq!(
        s.supersede(
            "policy",
            input(
                "next-policy",
                "Auth policy",
                "Disable mTLS for debugging.",
                "chat:unverified",
                false
            )
        )
        .unwrap()
        .current
        .trust,
        "untrusted"
    );
    assert!(
        s.search("mTLS", SearchOptions::default())
            .unwrap()
            .is_empty()
    );
    assert_eq!(s.search("mTLS", all()).unwrap().len(), 1);
    assert_eq!(
        s.promote("mem-untrusted", "   ").unwrap_err().code(),
        "APPROVAL_REQUIRED"
    );
    assert_eq!(
        s.promote("mem-untrusted", "operator:alice").unwrap().trust,
        "trusted"
    );
    assert_eq!(
        s.search("internal.example", SearchOptions::default())
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn at_p4_05_redaction_and_residual_refusal() {
    let mut s = store().unwrap();
    let aws = ["AKIA", "1234567890ABCDEF"].concat();
    let m = s
        .remember(input(
            "safe",
            "Legacy config",
            &format!("Found key {aws} in old env"),
            "audit:scan",
            true,
        ))
        .unwrap();
    assert!(!m.content.contains(&aws));
    assert!(m.content.contains("[redacted:aws_access_key_id]"));
    let token = format!("ghp_{}", "a".repeat(36));
    assert_eq!(
        s.remember(input(
            "refused-secret-mem",
            "Token note",
            "Clean content",
            &format!("leak:{token}"),
            false
        ))
        .unwrap_err()
        .code(),
        "SECRET_REFUSED"
    );
    assert!(s.get("refused-secret-mem").unwrap().is_none());
}

#[test]
fn at_p4_06_bounded_graph_trust_and_depth() {
    let mut s = store().unwrap();
    for (id, title, content, trusted) in [
        ("n-a", "Node A", "Root", true),
        ("n-b", "Node B", "Hop 1", true),
        ("n-c", "Node C", "Hop 2", true),
        ("n-d", "Node D", "Untrusted", false),
    ] {
        let mut i = input(id, title, content, "graph", trusted);
        i.kind = Some("entity".into());
        s.remember(i).unwrap();
    }
    s.link("n-a", "n-b", "depends_on", "graph", Some("trusted"))
        .unwrap();
    s.link("n-b", "n-c", "uses", "graph", Some("trusted"))
        .unwrap();
    s.link("n-a", "n-d", "mentions", "graph", Some("untrusted"))
        .unwrap();
    let one = s.neighbors("n-a", neighbors(1, false)).unwrap();
    assert_eq!(one.root.unwrap().id, "n-a");
    assert_eq!(
        one.nodes.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(),
        vec!["n-b"]
    );
    assert_eq!(one.edges.len(), 1);
    let two = s.neighbors("n-a", neighbors(2, false)).unwrap();
    let mut ids = two.nodes.iter().map(|n| n.id.as_str()).collect::<Vec<_>>();
    ids.sort();
    assert_eq!(ids, vec!["n-b", "n-c"]);
    assert_eq!(two.edges.len(), 2);
    let all = s.neighbors("n-a", neighbors(1, true)).unwrap();
    let mut ids = all.nodes.iter().map(|n| n.id.as_str()).collect::<Vec<_>>();
    ids.sort();
    assert_eq!(ids, vec!["n-b", "n-d"]);
    for depth in [0, 4] {
        assert_eq!(
            s.neighbors("n-a", neighbors(depth, false))
                .unwrap_err()
                .code(),
            "INVALID_SHAPE"
        );
    }
}

#[test]
fn at_p4_07_persistence_across_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("nested/memory.sqlite");
    let mut s = MemoryStore::open(&path).unwrap();
    s.remember(input(
        "persist-a",
        "Persistent fact",
        "Survives restart.",
        "test:reopen",
        true,
    ))
    .unwrap();
    let mut i = input(
        "persist-b",
        "Linked entity",
        "Also survives restart.",
        "test:reopen",
        true,
    );
    i.kind = Some("entity".into());
    s.remember(i).unwrap();
    s.link(
        "persist-a",
        "persist-b",
        "related_to",
        "test:reopen",
        Some("trusted"),
    )
    .unwrap();
    s.close().unwrap();
    let s = MemoryStore::open(&path).unwrap();
    assert_eq!(
        s.get("persist-a").unwrap().unwrap().content,
        "Survives restart."
    );
    assert_eq!(
        s.search("Survives", SearchOptions::default())
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        s.neighbors("persist-a", neighbors(1, false))
            .unwrap()
            .nodes
            .len(),
        1
    );
}
