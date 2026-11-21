pub(crate) fn quote(text: &str) -> String {
    let mut out = String::from("\"");
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if c < ' ' => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn run(text: &str, allowed: fn(u8) -> bool, min: usize) -> Option<usize> {
    let n = text.bytes().take_while(|b| allowed(*b)).count();
    (n >= min).then_some(n)
}

fn alnum(b: u8) -> bool {
    b.is_ascii_alphanumeric()
}
fn dash(b: u8) -> bool {
    alnum(b) || b == b'-'
}
fn url(b: u8) -> bool {
    dash(b) || b == b'_'
}

fn secret_at(text: &str, pattern: usize) -> Option<usize> {
    let prefixed = |prefix: &str, allowed, min| {
        text.strip_prefix(prefix)
            .and_then(|s| run(s, allowed, min))
            .map(|n| prefix.len() + n)
    };
    match pattern {
        0 => {
            let rest = text.strip_prefix("-----BEGIN ")?;
            let n = rest
                .bytes()
                .take_while(|b| b.is_ascii_uppercase() || *b == b' ')
                .count();
            let end = rest.get(..n)?;
            if end.ends_with("PRIVATE KEY") && rest.get(n..)?.starts_with("-----") {
                Some(11 + n + 5)
            } else {
                None
            }
        }
        1 => prefixed("AKIA", |b| b.is_ascii_uppercase() || b.is_ascii_digit(), 16).map(|_| 20),
        2 => ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"]
            .iter()
            .find_map(|p| prefixed(p, alnum, 36)),
        3 => ["xoxb-", "xoxa-", "xoxp-", "xoxr-", "xoxs-"]
            .iter()
            .find_map(|p| prefixed(p, dash, 10)),
        4 => ["sk-live-", "sk-test-"]
            .iter()
            .find_map(|p| prefixed(p, alnum, 10)),
        5 => prefixed("sk-", alnum, 20),
        6 => prefixed("AIza", url, 35).map(|_| 39),
        7 => {
            let a = prefixed("eyJ", url, 10)?;
            let b = run(text.get(a + 1..)?, url, 10)?;
            if text.get(a..a + 1)? != "." || text.get(a + 1 + b..a + 2 + b)? != "." {
                return None;
            }
            let c = run(text.get(a + 2 + b..)?, url, 10)?;
            Some(a + 2 + b + c)
        }
        _ => None,
    }
}

const PATTERNS: [&str; 8] = [
    "private_key_block",
    "aws_access_key_id",
    "github_token",
    "slack_token",
    "stripe_key",
    "openai_style_key",
    "google_api_key",
    "jwt",
];

pub(crate) fn redact(text: &str) -> String {
    let mut out = text.to_owned();
    for (pattern, name) in PATTERNS.iter().enumerate() {
        let mut next = String::new();
        let mut rest = out.as_str();
        while !rest.is_empty() {
            if let Some(n) = secret_at(rest, pattern) {
                next.push_str(&format!("[redacted:{name}]"));
                rest = rest.get(n..).unwrap_or_default();
            } else if let Some(c) = rest.chars().next() {
                next.push(c);
                rest = rest.get(c.len_utf8()..).unwrap_or_default();
            }
        }
        out = next;
    }
    out
}

pub(crate) fn has_secret(text: &str) -> bool {
    text.char_indices().any(|(i, _)| {
        text.get(i..)
            .is_some_and(|s| (0..PATTERNS.len()).any(|p| secret_at(s, p).is_some()))
    })
}

pub(crate) fn space(c: char) -> bool {
    matches!(c, '\u{9}'..='\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

pub(crate) fn fts(query: &str) -> String {
    query
        .split(space)
        .filter(|s| !s.is_empty())
        .map(|s| format!("\"{}\"", s.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" ")
}

pub(crate) fn hash(text: &str) -> String {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut bytes = text.as_bytes().to_vec();
    let bits = (bytes.len() as u64).wrapping_mul(8);
    bytes.push(0x80);
    while bytes.len() % 64 != 56 {
        bytes.push(0);
    }
    bytes.extend_from_slice(&bits.to_be_bytes());
    let mut state = [
        0x6a09e667_u32,
        0xbb67ae85,
        0x3c6ef372,
        0xa54ff53a,
        0x510e527f,
        0x9b05688c,
        0x1f83d9ab,
        0x5be0cd19,
    ];
    for block in bytes.as_chunks::<64>().0 {
        let mut w: Vec<u32> = Vec::with_capacity(64);
        for chunk in block.as_chunks::<4>().0 {
            w.push(u32::from_be_bytes(*chunk));
        }
        for i in 16..64 {
            let word = |offset: usize| w.get(i - offset).copied().unwrap_or_default();
            let x = word(15);
            let y = word(2);
            let s0 = x.rotate_right(7) ^ x.rotate_right(18) ^ (x >> 3);
            let s1 = y.rotate_right(17) ^ y.rotate_right(19) ^ (y >> 10);
            w.push(
                word(16)
                    .wrapping_add(s0)
                    .wrapping_add(word(7))
                    .wrapping_add(s1),
            );
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = state;
        for (word, k) in w.iter().zip(K) {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let t1 = h
                .wrapping_add(s1)
                .wrapping_add((e & f) ^ (!e & g))
                .wrapping_add(k)
                .wrapping_add(*word);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let t2 = s0.wrapping_add((a & b) ^ (a & c) ^ (b & c));
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        for (s, v) in state.iter_mut().zip([a, b, c, d, e, f, g, h]) {
            *s = s.wrapping_add(v);
        }
    }
    state.iter().map(|word| format!("{word:08x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_vectors_and_padding() {
        assert_eq!(
            hash(""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            hash("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            hash(&"a".repeat(1000)),
            "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3"
        );
    }

    #[test]
    fn canonical_string_escaping() {
        assert_eq!(
            quote("\"\\\n\r\t\u{8}\u{c}\u{0}é😀"),
            "\"\\\"\\\\\\n\\r\\t\\b\\f\\u0000é😀\""
        );
    }

    #[test]
    fn fts_quotes_tokens_and_javascript_whitespace() {
        assert_eq!(
            fts(" \tfoo-bar column:value \"OR\"\u{feff}"),
            "\"foo-bar\" \"column:value\" \"\"\"OR\"\"\""
        );
        assert_eq!(fts("\u{feff} \n"), "");
        assert_eq!(fts("a\u{85}b"), "\"a\u{85}b\"");
    }

    #[test]
    fn every_secret_pattern_and_global_replacement() {
        let cases = [
            (
                "private_key_block",
                ["-----BEGIN RSA ", "PRIVATE KEY-----"].concat(),
            ),
            ("aws_access_key_id", ["AKIA", "1234567890ABCDEF"].concat()),
            ("github_token", format!("ghp_{}", "a".repeat(36))),
            ("slack_token", format!("xoxb-{}", "a".repeat(10))),
            ("stripe_key", format!("sk-live-{}", "a".repeat(10))),
            ("openai_style_key", format!("sk-{}", "a".repeat(20))),
            ("google_api_key", format!("AIza{}", "a".repeat(35))),
            (
                "jwt",
                format!(
                    "eyJ{}.{}.{}",
                    "a".repeat(10),
                    "b".repeat(10),
                    "c".repeat(10)
                ),
            ),
        ];
        for (name, secret) in cases {
            let text = format!("é{secret} {secret}😀");
            assert!(has_secret(&text), "{name}");
            let redacted = redact(&text);
            assert_eq!(redacted, format!("é[redacted:{name}] [redacted:{name}]😀"));
            assert!(!has_secret(&redacted));
        }
        for clean in [
            "",
            "ordinary é text",
            "-----BEGIN PUBLIC KEY-----",
            "AKIAshort",
            "eyJabcdefghij:abcdefghij.abcdefghij",
            "eyJabcdefghij.abcdefghij:abcdefghij",
        ] {
            assert!(!has_secret(clean));
            assert_eq!(redact(clean), clean);
        }
        assert_eq!(secret_at("anything", 8), None);
    }

    #[test]
    fn pattern_boundaries_and_variants() {
        for prefix in ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"] {
            assert!(has_secret(&format!("{prefix}{}", "z".repeat(36))));
            assert!(!has_secret(&format!("{prefix}{}", "z".repeat(35))));
        }
        for prefix in [
            "xoxb-", "xoxa-", "xoxp-", "xoxr-", "xoxs-", "sk-live-", "sk-test-",
        ] {
            assert!(has_secret(&format!("{prefix}{}", "a".repeat(10))));
            assert!(!has_secret(&format!("{prefix}{}", "a".repeat(9))));
        }
    }
}
