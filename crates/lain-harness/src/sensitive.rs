//! Sensitive-path escalation, ported from oh-my-hermes (MIT),
//! `src/quality/verification_tiering.py`.
//!
//! A change touching a sensitive surface must force the thorough
//! verification lane regardless of diff size: a one-line edit under `auth/`
//! or to `.env.production` can be more consequential than a hundred-line
//! refactor elsewhere. Matching is by whole path component and basename
//! pattern, never a substring scan over the joined path, so
//! `src/blog/author.py` must never escalate on `auth` and
//! `docs/environment.md` must never escalate on `env`.

use serde::Serialize;

/// The escalation verdict for a matched path: which rule fired and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SensitivePath {
    pub category: &'static str,
    pub matched_path: String,
    pub reason: String,
}

/// (category, human label, whole-path-part patterns, basename patterns): a
/// path escalates when any of its parts matches a dir pattern, or its
/// basename matches a basename pattern, each pattern as a whole string.
struct Rule {
    category: &'static str,
    label: &'static str,
    dirs: &'static [&'static str],
    basenames: &'static [&'static str],
}

const RULES: &[Rule] = &[
    Rule {
        category: "auth",
        label: "authentication/authorization surface",
        dirs: &["auth", "auth-*", "*-auth"],
        basenames: &["*jwt*"],
    },
    Rule {
        category: "secrets_config",
        label: "secrets or environment configuration",
        dirs: &["secrets", "credentials"],
        basenames: &[".env", ".env.*", "*credential*"],
    },
    Rule {
        category: "schema_migrations",
        label: "schema or database migration",
        dirs: &["migrations", "migration"],
        basenames: &["schema.*"],
    },
    Rule {
        category: "payment_crypto",
        label: "payment or cryptographic surface",
        dirs: &["payment", "payments", "billing", "crypto"],
        basenames: &["*wallet*"],
    },
];

/// The escalation verdict for a set of changed paths, or `None`.
///
/// Rules are tried in `RULES` order and within a rule paths are tried in
/// `paths` order, so the same input always names the same category and
/// matched path. Blank entries are skipped rather than failing: this is a
/// pure classifier over caller-supplied metadata, not a validator.
pub fn sensitive_path_escalation(paths: &[String]) -> Option<SensitivePath> {
    for rule in RULES {
        for path in paths {
            if path.trim().is_empty() {
                continue;
            }
            let parts = path_parts(path);
            let Some(basename) = parts.last() else {
                continue;
            };
            let hits_dir = parts
                .iter()
                .any(|part| rule.dirs.iter().any(|p| fnmatch(part, p)));
            let hits_name = rule.basenames.iter().any(|p| fnmatch(basename, p));
            if hits_dir || hits_name {
                return Some(SensitivePath {
                    category: rule.category,
                    matched_path: path.clone(),
                    reason: format!(
                        "{path} is in the {}; verification escalates to the thorough \
                         lane regardless of change size.",
                        rule.label
                    ),
                });
            }
        }
    }
    None
}

/// A path as comparable, case-folded segments on every host: both separators
/// are folded and empty and `.` segments dropped, so a path handed to this
/// classifier reads the same way it reads everywhere else.
fn path_parts(path: &str) -> Vec<String> {
    path.replace('\\', "/")
        .split('/')
        .filter(|part| !matches!(*part, "" | "."))
        .map(|part| part.to_lowercase())
        .collect()
}

/// `fnmatch.fnmatchcase` over inputs the caller already folded to lowercase:
/// `*` spans any run of characters, `?` one, and `[seq]`/`[!seq]` a single
/// character in or out of the class (ranges included). Anything else must
/// match literally.
fn fnmatch(name: &str, pattern: &str) -> bool {
    let name: Vec<char> = name.chars().collect();
    let pattern: Vec<char> = pattern.chars().collect();
    fnmatch_at(&name, &pattern)
}

fn tail(s: &[char]) -> &[char] {
    s.get(1..).unwrap_or_default()
}

fn fnmatch_at(name: &[char], pattern: &[char]) -> bool {
    match pattern.split_first() {
        None => name.is_empty(),
        Some(('*', mut rest)) => {
            while let Some(('*', next)) = rest.split_first() {
                rest = next;
            }
            if rest.is_empty() {
                return true;
            }
            (0..=name.len()).any(|skip| name.get(skip..).is_some_and(|tail| fnmatch_at(tail, rest)))
        }
        Some(('?', rest)) => !name.is_empty() && fnmatch_at(tail(name), rest),
        Some(('[', _)) => {
            let Some(&c) = name.first() else {
                return false;
            };
            match class_tail(c, pattern) {
                Some((matched, rest)) => matched && fnmatch_at(tail(name), rest),
                // An unterminated `[` is a literal in fnmatch.
                None => c == '[' && fnmatch_at(tail(name), tail(pattern)),
            }
        }
        Some((&literal, rest)) => {
            matches!(name.first(), Some(&first) if first == literal) && fnmatch_at(tail(name), rest)
        }
    }
}

/// Parses the `[seq]`/`[!seq]` class at `pattern[0]` and reports whether `c`
/// is a member, plus the pattern after the closing `]`. `None` when the
/// class never closes.
fn class_tail(c: char, pattern: &[char]) -> Option<(bool, &[char])> {
    let mut rest = pattern.get(1..)?;
    let negated = matches!(rest.first(), Some('!') | Some('^'));
    if negated {
        rest = rest.get(1..)?;
    }
    let mut matched = false;
    let mut first = true;
    loop {
        let (&low, tail) = rest.split_first()?;
        rest = tail;
        if low == ']' && !first {
            return Some((matched != negated, rest));
        }
        first = false;
        // `a-z` range: `-` followed by a real char (not the closing `]`).
        let range = match (rest.first(), rest.get(1)) {
            (Some('-'), Some(&high)) if high != ']' => Some(high),
            _ => None,
        };
        if let Some(high) = range {
            rest = rest.get(2..)?;
            matched |= low <= c && c <= high;
            continue;
        }
        matched |= c == low;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).to_owned()).collect()
    }

    #[test]
    fn no_paths_and_ordinary_paths_never_escalate() {
        assert_eq!(sensitive_path_escalation(&[]), None);
        for path in [
            "README.md",
            "src/foo.py",
            "src/quality/routing_precision.py",
            "tests/test_cli.py",
        ] {
            assert_eq!(sensitive_path_escalation(&paths(&[path])), None, "{path}");
        }
    }

    #[test]
    fn a_filename_containing_the_letters_is_not_a_component_match() {
        // `author.py` merely contains `auth`; `environment.md` merely contains `env`.
        for path in [
            "src/blog/author.py",
            "authoring/notes.py",
            "docs/environment.md",
            "src/envelope.py",
        ] {
            assert_eq!(sensitive_path_escalation(&paths(&[path])), None, "{path}");
        }
    }

    #[test]
    fn auth_directory_and_jwt_filename_escalate_as_auth() {
        let result = sensitive_path_escalation(&paths(&["src/auth/login.py"]));
        let mark = result
            .as_ref()
            .map(|m| (m.category, m.matched_path.as_str()));
        assert_eq!(mark, Some(("auth", "src/auth/login.py")));
        assert!(
            result.is_some_and(|m| m.reason.contains("thorough")),
            "the reason must name the thorough lane"
        );
        let result = sensitive_path_escalation(&paths(&["lib/jwt_utils.py"]));
        assert_eq!(result.map(|m| m.category), Some("auth"));
    }

    #[test]
    fn dotenv_and_credential_files_escalate_as_secrets_config() {
        for path in [".env", ".env.local", ".env.production"] {
            let result = sensitive_path_escalation(&paths(&[path]));
            assert_eq!(result.map(|m| m.category), Some("secrets_config"), "{path}");
        }
        let result = sensitive_path_escalation(&paths(&["config/credentials.json"]));
        assert_eq!(result.map(|m| m.category), Some("secrets_config"));
    }

    #[test]
    fn migrations_and_schema_files_escalate_as_schema_migrations() {
        let result = sensitive_path_escalation(&paths(&["db/migrations/0001_init.sql"]));
        assert_eq!(result.map(|m| m.category), Some("schema_migrations"));
        let result = sensitive_path_escalation(&paths(&["schema.sql"]));
        assert_eq!(result.map(|m| m.category), Some("schema_migrations"));
    }

    #[test]
    fn payment_dirs_and_wallet_files_escalate_as_payment_crypto() {
        let result = sensitive_path_escalation(&paths(&["src/payments/charge.py"]));
        assert_eq!(result.map(|m| m.category), Some("payment_crypto"));
        let result = sensitive_path_escalation(&paths(&["wallet_signer.py"]));
        assert_eq!(result.map(|m| m.category), Some("payment_crypto"));
    }

    #[test]
    fn the_first_rule_and_first_path_win_deterministically() {
        let result = sensitive_path_escalation(&paths(&[
            "README.md",
            "src/foo.py",
            "src/auth/login.py",
            ".env",
        ]));
        let mark = result.map(|m| (m.category, m.matched_path));
        assert_eq!(mark, Some(("auth", "src/auth/login.py".to_owned())));
    }

    #[test]
    fn blank_entries_are_skipped() {
        assert_eq!(sensitive_path_escalation(&paths(&["", "   "])), None);
        // A path of only separators has no components to match.
        assert_eq!(sensitive_path_escalation(&paths(&["/", "./."])), None);
    }

    #[test]
    fn matching_is_case_insensitive_but_still_component_scoped() {
        let result = sensitive_path_escalation(&paths(&["src/Auth/Login.py"]));
        assert_eq!(result.map(|m| m.category), Some("auth"));
        assert_eq!(
            sensitive_path_escalation(&paths(&["src/Author/Notes.py"])),
            None
        );
    }

    #[test]
    fn fnmatch_star_question_and_classes() {
        assert!(fnmatch("auth-login", "auth-*"));
        assert!(fnmatch("my-auth", "*-auth"));
        assert!(fnmatch("jwt_utils", "*jwt*"));
        assert!(fnmatch(".env.production", ".env.*"));
        assert!(!fnmatch("env", ".env"));
        assert!(fnmatch("a.c", "?.c"));
        assert!(fnmatch("a1", "a[0-9]"));
        assert!(!fnmatch("ab", "a[0-9]"));
        assert!(fnmatch("ab", "a[!0-9]"));
        assert!(!fnmatch("auth", "auth-*"));
        // An unterminated class is a literal `[`.
        assert!(fnmatch("[x", "[x"));
    }
}
