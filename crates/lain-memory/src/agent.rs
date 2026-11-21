use rusqlite::{OptionalExtension, params};
use std::collections::HashSet;

use crate::{MemoryStore, Result, StoreError, compat, transaction, validate};

pub const SCRATCHPAD_MAX_UTF16: usize = 2000;
const RULE_LIMIT: usize = 3;
const RULE_MAX_UTF16: usize = 240;
const TOPIC_MAX_UTF16: usize = 1000;

pub(super) const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS session_scratchpads (
 session_id TEXT PRIMARY KEY, plan TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS procedural_rules (
 id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, priority INTEGER NOT NULL, rule TEXT NOT NULL,
 UNIQUE(session_id, priority));
CREATE VIRTUAL TABLE IF NOT EXISTS procedural_rules_fts USING fts5(topic);";

impl MemoryStore {
    pub fn scratchpad(&self, session_id: &str) -> Result<Option<String>> {
        validate(session_id, "session id", 120, true)?;
        Ok(self
            .db()?
            .query_row(
                "SELECT plan FROM session_scratchpads WHERE session_id=?",
                [session_id],
                |r| r.get(0),
            )
            .optional()?)
    }

    /// Store and return the redacted plan, so callers do not inject a different version than they persist.
    pub fn set_scratchpad(&mut self, session_id: &str, plan: &str) -> Result<String> {
        validate(session_id, "session id", 120, true)?;
        if plan.encode_utf16().count() > SCRATCHPAD_MAX_UTF16 || plan.contains('\0') {
            return Err(StoreError::InvalidShape("scratchpad plan"));
        }
        let plan = compat::redact(plan.trim());
        if !plan.is_empty() {
            validate(&plan, "scratchpad plan", SCRATCHPAD_MAX_UTF16, false)?;
        }
        if compat::has_secret(&compat::quote(session_id))
            || compat::has_secret(&compat::quote(&plan))
        {
            return Err(StoreError::SecretRefused);
        }
        self.db()?.execute(
            "INSERT INTO session_scratchpads (session_id,plan) VALUES (?,?)
             ON CONFLICT(session_id) DO UPDATE SET plan=excluded.plan",
            params![session_id, plan],
        )?;
        Ok(plan)
    }

    /// Replace one session's compact reflection and its search entries atomically.
    pub fn replace_procedural_rules(
        &mut self,
        session_id: &str,
        topic: &str,
        rules: &[String],
    ) -> Result<()> {
        validate(session_id, "session id", 120, true)?;
        if rules.is_empty()
            || rules.len() > RULE_LIMIT
            || topic.encode_utf16().count() > TOPIC_MAX_UTF16
        {
            return Err(StoreError::InvalidShape("procedural reflection"));
        }
        let topic = compat::redact(topic);
        for rule in rules {
            validate(rule, "procedural rule", RULE_MAX_UTF16, true)?;
            if rule.chars().any(char::is_control) {
                return Err(StoreError::InvalidShape("procedural rule"));
            }
        }
        if compat::has_secret(&compat::quote(session_id))
            || compat::has_secret(&compat::quote(&topic))
            || rules
                .iter()
                .any(|rule| compat::has_secret(&compat::quote(rule)))
        {
            return Err(StoreError::SecretRefused);
        }
        let tx = transaction(self.db()?)?;
        tx.execute(
            "DELETE FROM procedural_rules_fts WHERE rowid IN (SELECT id FROM procedural_rules WHERE session_id=?)",
            [session_id],
        )?;
        tx.execute(
            "DELETE FROM procedural_rules WHERE session_id=?",
            [session_id],
        )?;
        for (priority, rule) in (0_i32..).zip(rules) {
            tx.execute(
                "INSERT INTO procedural_rules (session_id,priority,rule) VALUES (?,?,?)",
                params![session_id, priority, rule],
            )?;
            tx.execute(
                "INSERT INTO procedural_rules_fts (rowid,topic) VALUES (?,?)",
                params![tx.last_insert_rowid(), &topic],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn procedural_rules(&self, session_id: &str) -> Result<Vec<String>> {
        validate(session_id, "session id", 120, true)?;
        let mut stmt = self
            .db()?
            .prepare("SELECT rule FROM procedural_rules WHERE session_id=? ORDER BY priority")?;
        Ok(stmt
            .query_map([session_id], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?)
    }

    pub fn search_procedural_rules(&self, query: &str, limit: usize) -> Result<Vec<String>> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        validate(query, "query", TOPIC_MAX_UTF16, false)?;
        let mut terms = HashSet::new();
        let query = query
            .split(|c: char| !c.is_alphanumeric())
            .filter(|word| word.chars().count() >= 3)
            .map(str::to_lowercase)
            .filter(|word| {
                !matches!(
                    word.as_str(),
                    "about"
                        | "and"
                        | "are"
                        | "can"
                        | "for"
                        | "from"
                        | "have"
                        | "please"
                        | "this"
                        | "that"
                        | "the"
                        | "use"
                        | "what"
                        | "when"
                        | "which"
                        | "with"
                )
            })
            .filter(|word| terms.insert(word.clone()))
            .take(12)
            .map(|word| compat::fts(&word))
            .collect::<Vec<_>>()
            .join(" OR ");
        if query.is_empty() {
            return Ok(Vec::new());
        }
        let mut stmt = self.db()?.prepare(
            "SELECT p.rule FROM procedural_rules_fts
             JOIN procedural_rules p ON p.id=procedural_rules_fts.rowid
             WHERE procedural_rules_fts MATCH ?
             ORDER BY bm25(procedural_rules_fts), p.priority, p.id DESC",
        )?;
        let mut seen = HashSet::new();
        let mut rules = Vec::new();
        for rule in stmt.query_map([query], |r| r.get::<_, String>(0))? {
            let rule = rule?;
            if seen.insert(rule.clone()) {
                rules.push(rule);
                if rules.len() >= limit.min(RULE_LIMIT) {
                    break;
                }
            }
        }
        Ok(rules)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scratchpad_replace_clear_and_redact() {
        let mut store = MemoryStore::open(":memory:").unwrap();
        let secret = format!("sk-{}", "a".repeat(24));
        assert_eq!(store.scratchpad("a").unwrap(), None);
        assert!(matches!(
            store.set_scratchpad(&secret, "plan"),
            Err(StoreError::SecretRefused)
        ));
        assert_eq!(
            store
                .set_scratchpad("a", &format!("  Never paste {secret}  "))
                .unwrap(),
            "Never paste [redacted:openai_style_key]"
        );
        assert!(store.set_scratchpad("a", &"📋".repeat(1001)).is_err());
        assert_eq!(
            store.scratchpad("a").unwrap().as_deref(),
            Some("Never paste [redacted:openai_style_key]")
        );
        assert_eq!(store.scratchpad("b").unwrap(), None);
        assert_eq!(
            store.set_scratchpad("a", "now verify").unwrap(),
            "now verify"
        );
        assert_eq!(store.set_scratchpad("a", " ").unwrap(), "");
        assert_eq!(store.scratchpad("a").unwrap().as_deref(), Some(""));
    }

    #[test]
    fn rules_are_ranked_scoped_and_replaced_without_stale_search_entries() {
        let mut store = MemoryStore::open(":memory:").unwrap();
        let rule = String::from("Check the command schema before retrying.");
        let replacement = String::from("Check the regression test before replying.");
        store
            .replace_procedural_rules("a", "cargo release", std::slice::from_ref(&rule))
            .unwrap();
        store
            .replace_procedural_rules("b", "cargo", std::slice::from_ref(&rule))
            .unwrap();
        assert_eq!(
            store.search_procedural_rules("cargo release", 3).unwrap(),
            std::slice::from_ref(&rule)
        );
        store
            .replace_procedural_rules("c", "cargo", std::slice::from_ref(&replacement))
            .unwrap();
        assert_eq!(
            store.search_procedural_rules("cargo release", 1).unwrap(),
            std::slice::from_ref(&rule)
        );
        assert!(
            store
                .replace_procedural_rules("a", "breaking", &["x".repeat(241)])
                .is_err()
        );
        assert_eq!(store.procedural_rules("a").unwrap(), [rule]);
        store
            .replace_procedural_rules("a", "zig", std::slice::from_ref(&replacement))
            .unwrap();
        assert!(
            store
                .search_procedural_rules("release", 3)
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            store.search_procedural_rules("zig build", 1).unwrap(),
            [replacement]
        );
    }
}
