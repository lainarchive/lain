mod agent;
mod compat;

pub use agent::SCRATCHPAD_MAX_UTF16;

use rusqlite::{Connection, OptionalExtension, Row, Transaction, TransactionBehavior, params};
use std::{collections::HashSet, path::Path, sync::Mutex};

pub const MEMORY_KINDS: [&str; 5] = ["fact", "decision", "preference", "procedure", "entity"];
pub const MEMORY_TRUST_LEVELS: [&str; 2] = ["trusted", "untrusted"];

#[derive(thiserror::Error)]
#[non_exhaustive]
pub enum StoreError {
    #[error("database path required")]
    PathRequired,
    #[error("memory store is closed")]
    Closed,
    #[error("invalid {0}")]
    InvalidShape(&'static str),
    #[error("invalid memory kind")]
    InvalidKind,
    #[error("invalid memory trust")]
    InvalidTrust,
    #[error("memory payload contains a residual secret")]
    SecretRefused,
    #[error("memory not found")]
    NotFound,
    #[error("memory already superseded")]
    AlreadySuperseded,
    #[error("memory id already exists")]
    DuplicateId,
    #[error("explicit approval required")]
    ApprovalRequired,
    #[error("SQLite operation failed")]
    Sqlite(#[from] rusqlite::Error),
    #[error("database directory creation failed")]
    Io(#[from] std::io::Error),
    #[error("identifier clock unavailable")]
    Clock,
}

impl StoreError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::PathRequired => "STORE_PATH_REQUIRED",
            Self::Closed => "STORE_CLOSED",
            Self::InvalidShape(_) => "INVALID_SHAPE",
            Self::InvalidKind => "INVALID_MEMORY_KIND",
            Self::InvalidTrust => "INVALID_MEMORY_TRUST",
            Self::SecretRefused => "SECRET_REFUSED",
            Self::NotFound => "NOT_FOUND",
            Self::AlreadySuperseded => "ALREADY_SUPERSEDED",
            Self::DuplicateId => "DUPLICATE_ID",
            Self::ApprovalRequired => "APPROVAL_REQUIRED",
            Self::Sqlite(_) => "ERR_SQLITE_ERROR",
            Self::Io(_) => "IO_ERROR",
            Self::Clock => "CLOCK_ERROR",
        }
    }
}

pub type Result<T> = std::result::Result<T, StoreError>;

impl std::fmt::Debug for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StoreError")
            .field("code", &self.code())
            .field("message", &compat::redact(&self.to_string()))
            .finish()
    }
}

fn transaction(db: &Connection) -> Result<Transaction<'_>> {
    Ok(Transaction::new_unchecked(
        db,
        TransactionBehavior::Immediate,
    )?)
}

#[derive(Debug, Clone, Default)]
pub struct MemoryInput {
    pub id: Option<String>,
    pub title: String,
    pub content: String,
    pub kind: Option<String>,
    pub trust: Option<String>,
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryRecord {
    pub id: String,
    pub title: String,
    pub content: String,
    pub kind: String,
    pub trust: String,
    pub source: String,
    pub created_at: String,
    pub updated_at: String,
    pub superseded_by: Option<String>,
    pub content_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryEdge {
    pub from_id: String,
    pub to_id: String,
    pub relation: String,
    pub source: String,
    pub trust: String,
    pub created_at: String,
}

#[derive(Debug, Clone)]
pub struct SearchOptions {
    pub limit: i64,
    pub include_untrusted: bool,
}
impl Default for SearchOptions {
    fn default() -> Self {
        Self {
            limit: 10,
            include_untrusted: false,
        }
    }
}
#[derive(Debug, Clone)]
pub struct NeighborOptions {
    pub depth: i64,
    pub include_untrusted: bool,
}
impl Default for NeighborOptions {
    fn default() -> Self {
        Self {
            depth: 1,
            include_untrusted: false,
        }
    }
}
#[derive(Debug, Default)]
pub struct Neighbors {
    pub root: Option<MemoryRecord>,
    pub nodes: Vec<MemoryRecord>,
    pub edges: Vec<MemoryEdge>,
}
#[derive(Debug)]
pub struct Superseded {
    pub superseded: MemoryRecord,
    pub current: MemoryRecord,
}
#[derive(Debug)]
pub struct Provenance {
    pub id: String,
    pub source: String,
    pub trust: String,
    pub created_at: String,
    pub updated_at: String,
    pub superseded_by: Option<String>,
    pub supersedes: Vec<String>,
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS memories (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL, kind TEXT NOT NULL,
 trust TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 superseded_by TEXT, content_hash TEXT NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(id UNINDEXED, title, content);
CREATE TABLE IF NOT EXISTS memory_edges (
 from_id TEXT NOT NULL, to_id TEXT NOT NULL, relation TEXT NOT NULL, source TEXT NOT NULL,
 trust TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (from_id, to_id, relation));
CREATE INDEX IF NOT EXISTS idx_memories_superseded ON memories(superseded_by);
CREATE INDEX IF NOT EXISTS idx_memories_trust ON memories(trust);
CREATE INDEX IF NOT EXISTS idx_edges_to ON memory_edges(to_id);";

fn validate(value: &str, name: &'static str, max: usize, blank: bool) -> Result<()> {
    let len = value.encode_utf16().count();
    if len == 0 || len > max || (blank && value.trim_matches(compat::space).is_empty()) {
        return Err(StoreError::InvalidShape(name));
    }
    Ok(())
}

fn trust(value: Option<&str>) -> Result<&str> {
    let value = value.unwrap_or("untrusted");
    if MEMORY_TRUST_LEVELS.contains(&value) {
        Ok(value)
    } else {
        Err(StoreError::InvalidTrust)
    }
}

fn row_memory(row: &Row<'_>) -> rusqlite::Result<MemoryRecord> {
    Ok(MemoryRecord {
        id: row.get(0)?,
        title: row.get(1)?,
        content: row.get(2)?,
        kind: row.get(3)?,
        trust: row.get(4)?,
        source: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
        superseded_by: row.get(8)?,
        content_hash: row.get(9)?,
    })
}
fn row_edge(row: &Row<'_>) -> rusqlite::Result<MemoryEdge> {
    Ok(MemoryEdge {
        from_id: row.get(0)?,
        to_id: row.get(1)?,
        relation: row.get(2)?,
        source: row.get(3)?,
        trust: row.get(4)?,
        created_at: row.get(5)?,
    })
}
fn lookup(db: &Connection, id: &str) -> Result<Option<MemoryRecord>> {
    Ok(db
        .query_row("SELECT * FROM memories WHERE id = ?", [id], row_memory)
        .optional()?)
}
fn required(db: &Connection, id: &str) -> Result<MemoryRecord> {
    lookup(db, id)?.ok_or(StoreError::NotFound)
}
fn now(db: &Connection) -> Result<String> {
    Ok(
        db.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |r| {
            r.get(0)
        })?,
    )
}

static LAST_ID: Mutex<u128> = Mutex::new(0);
fn new_id(db: &Connection) -> Result<String> {
    let time = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| StoreError::Clock)?
        .as_millis();
    let random: Vec<u8> = db.query_row("SELECT randomblob(10)", [], |r| r.get(0))?;
    let mut value = time << 80;
    for (i, byte) in random.iter().enumerate() {
        value |= (*byte as u128) << (8 * (9 - i));
    }
    let mut last = LAST_ID.lock().map_err(|_| StoreError::Clock)?;
    value = value.max(last.saturating_add(1));
    *last = value;
    let alphabet = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let mut result = String::new();
    for shift in (0..26).rev() {
        let c = alphabet
            .get(((value >> (shift * 5)) & 31) as usize)
            .copied()
            .ok_or(StoreError::Clock)?;
        result.push(char::from(c));
    }
    Ok(result)
}

fn prepare(db: &Connection, input: MemoryInput) -> Result<MemoryRecord> {
    let id = match input.id {
        Some(id) => id,
        None => new_id(db)?,
    };
    validate(&id, "id", 200, true)?;
    validate(&input.title, "title", 1000, true)?;
    validate(&input.content, "content", 1_000_000, true)?;
    validate(&input.source, "source", 500, true)?;
    let kind = input.kind.unwrap_or_else(|| "fact".into());
    if !MEMORY_KINDS.contains(&kind.as_str()) {
        return Err(StoreError::InvalidKind);
    }
    let trust = trust(input.trust.as_deref())?.to_owned();
    let title = compat::redact(&input.title);
    let content = compat::redact(&input.content);
    let serialized = format!(
        "{{\"content\":{},\"id\":{},\"kind\":{},\"source\":{},\"title\":{}}}",
        compat::quote(&content),
        compat::quote(&id),
        compat::quote(&kind),
        compat::quote(&input.source),
        compat::quote(&title)
    );
    if compat::has_secret(&serialized) {
        return Err(StoreError::SecretRefused);
    }
    let content_hash = compat::hash(&format!(
        "{{\"content\":{},\"kind\":{},\"title\":{}}}",
        compat::quote(&content),
        compat::quote(&kind),
        compat::quote(&title)
    ));
    let timestamp = now(db)?;
    Ok(MemoryRecord {
        id,
        title,
        content,
        kind,
        trust,
        source: input.source,
        created_at: timestamp.clone(),
        updated_at: timestamp,
        superseded_by: None,
        content_hash,
    })
}

fn insert(db: &Connection, m: &MemoryRecord) -> Result<()> {
    db.execute(
        "INSERT INTO memories VALUES (?,?,?,?,?,?,?,?,NULL,?)",
        params![
            m.id,
            m.title,
            m.content,
            m.kind,
            m.trust,
            m.source,
            m.created_at,
            m.updated_at,
            m.content_hash
        ],
    )?;
    insert_fts(db, m)
}
fn insert_fts(db: &Connection, m: &MemoryRecord) -> Result<()> {
    db.execute(
        "INSERT INTO memories_fts VALUES (?,?,?)",
        params![m.id, m.title, m.content],
    )?;
    Ok(())
}
fn index(db: &Connection, m: &MemoryRecord) -> Result<()> {
    db.execute("DELETE FROM memories_fts WHERE id=?", [&m.id])?;
    insert_fts(db, m)
}

#[derive(Debug)]
pub struct MemoryStore {
    db: Option<Connection>,
}
impl MemoryStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        if path.as_os_str().is_empty()
            || path
                .to_string_lossy()
                .trim_matches(compat::space)
                .is_empty()
        {
            return Err(StoreError::PathRequired);
        }
        if path != Path::new(":memory:")
            && let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty())
        {
            std::fs::create_dir_all(parent)?;
        }
        let db = Connection::open(path)?;
        db.busy_timeout(std::time::Duration::ZERO)?;
        db.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;",
        )?;
        db.execute_batch(SCHEMA)?;
        db.execute_batch(agent::SCHEMA)?;
        Ok(Self { db: Some(db) })
    }
    fn db(&self) -> Result<&Connection> {
        self.db.as_ref().ok_or(StoreError::Closed)
    }
    pub fn close(&mut self) -> Result<()> {
        if let Some(db) = self.db.take()
            && let Err((db, err)) = db.close()
        {
            self.db = Some(db);
            return Err(err.into());
        }
        Ok(())
    }
    pub fn get(&self, id: &str) -> Result<Option<MemoryRecord>> {
        let db = self.db()?;
        validate(id, "id", 200, true)?;
        lookup(db, id)
    }
    pub fn remember(&mut self, input: MemoryInput) -> Result<MemoryRecord> {
        let db = self.db()?;
        let mut m = prepare(db, input)?;
        let tx = transaction(db)?;
        if let Some(old) = lookup(&tx, &m.id)? {
            if old.trust == "untrusted" {
                m.trust = "untrusted".into();
            }
            tx.execute("UPDATE memories SET title=?,content=?,kind=?,trust=?,source=?,updated_at=?,content_hash=? WHERE id=?",
                params![m.title,m.content,m.kind,m.trust,m.source,m.updated_at,m.content_hash,m.id])?;
            index(&tx, &m)?;
        } else {
            insert(&tx, &m)?;
        }
        let result = required(&tx, &m.id)?;
        tx.commit()?;
        Ok(result)
    }
    pub fn search(&self, query: &str, opts: SearchOptions) -> Result<Vec<MemoryRecord>> {
        let db = self.db()?;
        validate(query, "query", 1000, false)?;
        let query = compat::fts(query);
        if query.is_empty() {
            return Ok(Vec::new());
        }
        if !(1..=100).contains(&opts.limit) {
            return Err(StoreError::InvalidShape("limit"));
        }
        let mut stmt = db.prepare(
            "SELECT m.* FROM memories_fts f JOIN memories m ON m.id=f.id
            WHERE memories_fts MATCH ? AND m.superseded_by IS NULL AND (?=1 OR m.trust='trusted')
            ORDER BY bm25(memories_fts), m.updated_at DESC LIMIT ?",
        )?;
        Ok(stmt
            .query_map(
                params![query, opts.include_untrusted, opts.limit],
                row_memory,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }
    pub fn supersede(&mut self, old_id: &str, input: MemoryInput) -> Result<Superseded> {
        let db = self.db()?;
        validate(old_id, "oldId", 200, true)?;
        let m = prepare(db, input)?;
        if m.id == old_id {
            return Err(StoreError::InvalidShape("distinct id"));
        }
        let tx = transaction(db)?;
        let old = required(&tx, old_id)?;
        if old.superseded_by.is_some() {
            return Err(StoreError::AlreadySuperseded);
        }
        if lookup(&tx, &m.id)?.is_some() {
            return Err(StoreError::DuplicateId);
        }
        insert(&tx, &m)?;
        tx.execute(
            "UPDATE memories SET superseded_by=?,updated_at=? WHERE id=?",
            params![m.id, m.updated_at, old_id],
        )?;
        let result = Superseded {
            superseded: required(&tx, old_id)?,
            current: required(&tx, &m.id)?,
        };
        tx.commit()?;
        Ok(result)
    }
    pub fn promote(&mut self, id: &str, approved_by: &str) -> Result<MemoryRecord> {
        let db = self.db()?;
        validate(id, "id", 200, true)?;
        if approved_by.trim_matches(compat::space).is_empty() {
            return Err(StoreError::ApprovalRequired);
        }
        let tx = transaction(db)?;
        let old = required(&tx, id)?;
        if old.trust != "trusted" {
            tx.execute(
                "UPDATE memories SET trust='trusted',updated_at=? WHERE id=?",
                params![now(&tx)?, id],
            )?;
        }
        let result = required(&tx, id)?;
        tx.commit()?;
        Ok(result)
    }
    pub fn link(
        &mut self,
        from: &str,
        to: &str,
        relation: &str,
        source: &str,
        level: Option<&str>,
    ) -> Result<MemoryEdge> {
        let db = self.db()?;
        validate(from, "fromId", 200, true)?;
        validate(to, "toId", 200, true)?;
        validate(relation, "relation", 200, true)?;
        validate(source, "source", 500, true)?;
        let level = trust(level)?;
        let timestamp = now(db)?;
        let tx = transaction(db)?;
        required(&tx, from)?;
        required(&tx, to)?;
        tx.execute(
            "INSERT OR REPLACE INTO memory_edges VALUES (?,?,?,?,?,?)",
            params![from, to, relation, source, level, timestamp],
        )?;
        tx.commit()?;
        Ok(MemoryEdge {
            from_id: from.into(),
            to_id: to.into(),
            relation: relation.into(),
            source: source.into(),
            trust: level.into(),
            created_at: timestamp,
        })
    }
    pub fn neighbors(&self, id: &str, opts: NeighborOptions) -> Result<Neighbors> {
        let db = self.db()?;
        validate(id, "id", 200, true)?;
        if !(1..=3).contains(&opts.depth) {
            return Err(StoreError::InvalidShape("depth"));
        }
        let root = lookup(db, id)?;
        if root
            .as_ref()
            .is_none_or(|r| !opts.include_untrusted && r.trust != "trusted")
        {
            return Ok(Neighbors::default());
        }
        let mut result = Neighbors {
            root,
            ..Neighbors::default()
        };
        let mut visited = HashSet::from([id.to_owned()]);
        let mut edges = HashSet::new();
        let mut frontier = vec![id.to_owned()];
        for _ in 0..opts.depth {
            let mut next = Vec::new();
            for current in frontier {
                let mut stmt = db.prepare("SELECT * FROM memory_edges WHERE (from_id=? OR to_id=?) AND (?=1 OR trust='trusted') ORDER BY created_at,from_id,to_id,relation")?;
                let adjacent =
                    stmt.query_map(params![current, current, opts.include_untrusted], row_edge)?;
                for edge in adjacent {
                    let edge = edge?;
                    let other = if edge.from_id == current {
                        &edge.to_id
                    } else {
                        &edge.from_id
                    };
                    let Some(node) = lookup(db, other)? else {
                        continue;
                    };
                    if !opts.include_untrusted && node.trust != "trusted" {
                        continue;
                    }
                    if visited.insert(other.clone()) {
                        next.push(other.clone());
                        result.nodes.push(node);
                    }
                    let key = format!("{}\0{}\0{}", edge.from_id, edge.to_id, edge.relation);
                    if edges.insert(key) {
                        result.edges.push(edge);
                    }
                }
            }
            frontier = next;
        }
        Ok(result)
    }
    pub fn provenance(&self, id: &str) -> Result<Option<Provenance>> {
        let Some(m) = self.get(id)? else {
            return Ok(None);
        };
        let mut stmt = self
            .db()?
            .prepare("SELECT id FROM memories WHERE superseded_by=? ORDER BY created_at,id")?;
        let supersedes = stmt
            .query_map([id], |r| r.get(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(Some(Provenance {
            id: m.id,
            source: m.source,
            trust: m.trust,
            created_at: m.created_at,
            updated_at: m.updated_at,
            superseded_by: m.superseded_by,
            supersedes,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(id: &str) -> MemoryInput {
        MemoryInput {
            id: Some(id.into()),
            title: "title".into(),
            content: "content".into(),
            source: "test".into(),
            ..MemoryInput::default()
        }
    }

    #[test]
    fn validation_and_enum_branches() {
        for value in ["", " ", "\u{feff}", "long"] {
            assert!(validate(value, "field", 3, true).is_err());
        }
        assert!(validate(" ", "field", 3, false).is_ok());
        assert!(validate("😀", "field", 1, false).is_err());
        assert_eq!(trust(None).unwrap(), "untrusted");
        for value in MEMORY_TRUST_LEVELS {
            assert_eq!(trust(Some(value)).unwrap(), value);
        }
        assert_eq!(
            trust(Some("invalid")).unwrap_err().code(),
            "INVALID_MEMORY_TRUST"
        );
        let db = Connection::open_in_memory().unwrap();
        for kind in MEMORY_KINDS {
            let mut i = input("id");
            i.kind = Some(kind.into());
            assert_eq!(prepare(&db, i).unwrap().kind, kind);
        }
        let mut i = input("id");
        i.kind = Some("bad".into());
        assert_eq!(prepare(&db, i).unwrap_err().code(), "INVALID_MEMORY_KIND");
        let mut i = input("id");
        i.trust = Some("bad".into());
        assert_eq!(prepare(&db, i).unwrap_err().code(), "INVALID_MEMORY_TRUST");
        let mut i = input("id");
        i.title.clear();
        assert!(prepare(&db, i).is_err());
    }

    #[test]
    fn fresh_insert_and_update_keep_one_fts_row() {
        let mut store = MemoryStore::open(":memory:").unwrap();
        store.remember(input("id")).unwrap();
        let count = store
            .db()
            .unwrap()
            .query_row("SELECT count(*) FROM memories_fts WHERE id='id'", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap();
        assert_eq!(count, 1);
        let mut updated = input("id");
        updated.content = "updated content".into();
        store.remember(updated).unwrap();
        let (count, content) = store
            .db()
            .unwrap()
            .query_row(
                "SELECT count(*), content FROM memories_fts WHERE id='id'",
                [],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
            )
            .unwrap();
        assert_eq!(count, 1);
        assert_eq!(content, "updated content");
    }

    #[test]
    fn fts5_and_durability_pragmas_and_schema() {
        let dir = tempfile::tempdir().unwrap();
        let store = MemoryStore::open(dir.path().join("memory.sqlite")).unwrap();
        let db = store.db().unwrap();
        assert_eq!(
            db.query_row("PRAGMA journal_mode", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "wal"
        );
        assert_eq!(
            db.query_row("PRAGMA synchronous", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            2
        );
        assert_eq!(
            db.query_row("PRAGMA foreign_keys", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            db.query_row("PRAGMA busy_timeout", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            db.query_row("SELECT sqlite_compileoption_used('ENABLE_FTS5')", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            db.query_row(
                "SELECT count(*) FROM pragma_table_info('memories')",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            10
        );
        db.execute(
            "INSERT INTO memories_fts VALUES ('id','needle','haystack')",
            [],
        )
        .unwrap();
        assert_eq!(
            db.query_row(
                "SELECT id FROM memories_fts WHERE memories_fts MATCH 'needle'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "id"
        );
    }

    #[test]
    fn open_close_and_reason_codes() {
        for path in ["", " ", "\u{feff}"] {
            assert_eq!(
                MemoryStore::open(path).unwrap_err().code(),
                "STORE_PATH_REQUIRED"
            );
        }
        let mut s = MemoryStore::open(":memory:").unwrap();
        s.close().unwrap();
        s.close().unwrap();
        assert_eq!(s.get("id").unwrap_err().code(), "STORE_CLOSED");
        assert_eq!(s.remember(input("id")).unwrap_err().code(), "STORE_CLOSED");
        assert!(s.search("x", SearchOptions::default()).is_err());
        assert!(s.supersede("id", input("next")).is_err());
        assert!(s.promote("id", "operator").is_err());
        assert!(s.link("id", "to", "r", "s", None).is_err());
        assert!(s.neighbors("id", NeighborOptions::default()).is_err());
        assert!(s.provenance("id").is_err());
        let codes = [
            (StoreError::Closed, "STORE_CLOSED"),
            (StoreError::Clock, "CLOCK_ERROR"),
            (
                StoreError::Sqlite(rusqlite::Error::InvalidQuery),
                "ERR_SQLITE_ERROR",
            ),
            (StoreError::Io(std::io::Error::other("failure")), "IO_ERROR"),
        ];
        for (e, code) in codes {
            assert_eq!(e.code(), code);
            assert!(format!("{e:?}").contains(code));
        }
    }

    #[test]
    fn ids_are_ulids_and_monotonic() {
        let db = Connection::open_in_memory().unwrap();
        let a = new_id(&db).unwrap();
        let b = new_id(&db).unwrap();
        assert_eq!(a.len(), 26);
        assert_eq!(b.len(), 26);
        assert!(a < b);
        assert!(
            a.bytes()
                .all(|c| b"0123456789ABCDEFGHJKMNPQRSTVWXYZ".contains(&c))
        );
        let mut i = input("unused");
        i.id = None;
        assert_eq!(prepare(&db, i).unwrap().id.len(), 26);
    }

    #[test]
    fn search_bounds_empty_and_punctuation() {
        let mut s = MemoryStore::open(":memory:").unwrap();
        let mut i = input("id");
        i.trust = Some("trusted".into());
        s.remember(i).unwrap();
        assert!(s.search("", SearchOptions::default()).is_err());
        assert!(
            s.search(&"a".repeat(1001), SearchOptions::default())
                .is_err()
        );
        for limit in [0, 101, -1] {
            assert!(
                s.search(
                    "content",
                    SearchOptions {
                        limit,
                        ..SearchOptions::default()
                    }
                )
                .is_err()
            );
            assert!(
                s.search(
                    " \u{feff}",
                    SearchOptions {
                        limit,
                        ..SearchOptions::default()
                    }
                )
                .unwrap()
                .is_empty()
            );
        }
        for query in ["a-b", "column:foo", "\"OR\"", "\"", "*", "absent"] {
            assert!(
                s.search(query, SearchOptions::default())
                    .unwrap()
                    .is_empty()
            );
        }
        for limit in [1, 100] {
            assert_eq!(
                s.search(
                    "content",
                    SearchOptions {
                        limit,
                        ..SearchOptions::default()
                    }
                )
                .unwrap()
                .len(),
                1
            );
        }
    }

    #[test]
    fn supersede_errors_are_atomic_and_updates_preserve_history() {
        let mut s = MemoryStore::open(":memory:").unwrap();
        assert_eq!(
            s.supersede("absent", input("new")).unwrap_err().code(),
            "NOT_FOUND"
        );
        assert!(s.get("new").unwrap().is_none());
        let a = s.remember(input("a")).unwrap();
        s.remember(input("b")).unwrap();
        assert_eq!(
            s.supersede("a", input("a")).unwrap_err().code(),
            "INVALID_SHAPE"
        );
        assert_eq!(
            s.supersede("a", input("b")).unwrap_err().code(),
            "DUPLICATE_ID"
        );
        assert_eq!(s.get("a").unwrap().unwrap(), a);
        s.supersede("a", input("c")).unwrap();
        let updated = s.remember(input("a")).unwrap();
        assert_eq!(updated.created_at, a.created_at);
        assert_eq!(updated.superseded_by.as_deref(), Some("c"));
        assert_eq!(
            s.supersede("a", input("d")).unwrap_err().code(),
            "ALREADY_SUPERSEDED"
        );
        assert!(s.get("d").unwrap().is_none());
        assert_eq!(
            s.promote("missing", "operator").unwrap_err().code(),
            "NOT_FOUND"
        );
        let promoted = s.promote("c", "operator").unwrap();
        assert_eq!(s.promote("c", "operator").unwrap(), promoted);
        assert_eq!(s.remember(input("c")).unwrap().trust, "untrusted");
    }

    #[test]
    fn graph_missing_nodes_trust_cycles_reverse_edges_and_upsert() {
        let mut s = MemoryStore::open(":memory:").unwrap();
        assert!(
            s.neighbors("missing", NeighborOptions::default())
                .unwrap()
                .root
                .is_none()
        );
        for id in ["a", "b", "c"] {
            let mut i = input(id);
            i.trust = Some("trusted".into());
            s.remember(i).unwrap();
        }
        s.remember(input("u")).unwrap();
        assert!(
            s.neighbors("u", NeighborOptions::default())
                .unwrap()
                .root
                .is_none()
        );
        assert!(
            s.neighbors(
                "u",
                NeighborOptions {
                    include_untrusted: true,
                    ..NeighborOptions::default()
                }
            )
            .unwrap()
            .root
            .is_some()
        );
        for (from, to) in [("missing", "a"), ("a", "missing")] {
            assert_eq!(
                s.link(from, to, "r", "test", None).unwrap_err().code(),
                "NOT_FOUND"
            );
        }
        assert!(s.link("a", "b", "r", "test", Some("bad")).is_err());
        assert!(s.link("a", "b", " ", "test", None).is_err());
        s.link("a", "b", "r", "test", None).unwrap();
        assert!(
            s.neighbors("a", NeighborOptions::default())
                .unwrap()
                .nodes
                .is_empty()
        );
        s.link("a", "b", "r", "updated", Some("trusted")).unwrap();
        s.link("b", "c", "r", "test", Some("trusted")).unwrap();
        s.link("c", "a", "r", "test", Some("trusted")).unwrap();
        s.link("a", "a", "self", "test", Some("trusted")).unwrap();
        s.link("a", "u", "r", "test", Some("trusted")).unwrap();
        let result = s
            .neighbors(
                "a",
                NeighborOptions {
                    depth: 3,
                    include_untrusted: false,
                },
            )
            .unwrap();
        assert_eq!(result.nodes.len(), 2);
        assert_eq!(result.edges.len(), 4);
        assert!(result.edges.iter().any(|e| e.source == "updated"));
        let reverse = s.neighbors("b", NeighborOptions::default()).unwrap();
        assert_eq!(reverse.nodes.len(), 2);
        s.db()
            .unwrap()
            .execute(
                "INSERT INTO memory_edges VALUES ('a','gone','r','test','trusted','0')",
                [],
            )
            .unwrap();
        assert_eq!(
            s.neighbors("a", NeighborOptions::default())
                .unwrap()
                .nodes
                .len(),
            2
        );
    }

    #[test]
    fn redacted_hash_matches_node_and_backstop_covers_metadata() {
        let mut s = MemoryStore::open(":memory:").unwrap();
        let mut i = input("id");
        i.title = "title".into();
        i.content = "content".into();
        let m = s.remember(i).unwrap();
        assert_eq!(
            m.content_hash,
            compat::hash("{\"content\":\"content\",\"kind\":\"fact\",\"title\":\"title\"}")
        );
        assert_eq!(
            m.content_hash,
            "05811745601ec7af2baecf53d11c48a2e07e445a37f6ebb28ceb1de590e83941"
        );
        let secret = format!("ghp_{}", "a".repeat(36));
        let mut i = input(&secret);
        assert_eq!(s.remember(i.clone()).unwrap_err().code(), "SECRET_REFUSED");
        i.id = Some("redacted".into());
        i.title = secret.clone();
        i.content = secret.clone();
        let m = s.remember(i).unwrap();
        assert_eq!(m.title, "[redacted:github_token]");
        assert_eq!(m.content, m.title);
        assert_eq!(
            m.content_hash,
            compat::hash(
                "{\"content\":\"[redacted:github_token]\",\"kind\":\"fact\",\"title\":\"[redacted:github_token]\"}"
            )
        );
        let error = StoreError::Io(std::io::Error::other(secret.clone()));
        assert!(!format!("{error:?}").contains(&secret));
    }
}
