use std::{
    borrow::Cow,
    io::{self, Read},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use cap_std::{
    ambient_authority,
    fs::{Dir, Metadata},
};
use tree_sitter::{Node, ParseOptions, ParseState, Parser};

const MAX_ENTRIES: usize = 16_384;
const MAX_DEPTH: usize = 32;
const MAX_SOURCE_BYTES: usize = 256 * 1024;
const MAX_TOTAL_BYTES: usize = 16 * 1024 * 1024;
const MAX_MAP_BYTES: usize = 16 * 1024;
const MAX_SYMBOLS_PER_FILE: usize = 256;
const MAX_SIGNATURE_BYTES: usize = 240;
const MAX_DOC_BYTES: usize = 120;
const MAX_SCAN_TIME: Duration = Duration::from_secs(5);

#[derive(Debug, thiserror::Error)]
pub enum RepoMapError {
    #[error("cannot read workspace: {0}")]
    Workspace(#[from] io::Error),
    #[error("cannot load repository grammar: {0}")]
    Grammar(#[from] tree_sitter::LanguageError),
}

/// A bounded outline of Rust, TypeScript and TSX files, rendered with workspace-relative paths.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct RepoMap {
    text: String,
    truncated: bool,
}

impl RepoMap {
    /// Scans a caller-authorized workspace; symlinks, hidden paths and common build/vendor directories are skipped.
    pub fn scan(root: impl AsRef<Path>) -> Result<Self, RepoMapError> {
        let root = Dir::open_ambient_dir(root, ambient_authority())?;
        let deadline = Instant::now() + MAX_SCAN_TIME;
        let mut index = Index::new()?;
        let mut map = Self::default();
        let mut entries_left = MAX_ENTRIES;
        let mut bytes_left = MAX_TOTAL_BYTES;
        let mut pending = vec![(PathBuf::new(), 0)];
        while let Some((directory, depth)) = pending.pop() {
            let entries = if depth == 0 {
                root.entries()
            } else {
                root.read_dir(&directory)
            };
            let entries = match entries {
                Ok(entries) => entries,
                Err(error) if depth == 0 => return Err(error.into()),
                Err(_) => {
                    map.truncated = true;
                    continue;
                }
            };
            let mut files = Vec::new();
            let mut subdirs = Vec::new();
            for entry in entries.take(entries_left) {
                if Instant::now() >= deadline {
                    map.truncated = true;
                    return Ok(map);
                }
                entries_left -= 1;
                let Ok(entry) = entry else {
                    map.truncated = true;
                    continue;
                };
                let name = entry.file_name();
                let Some(name) = name.to_str() else { continue };
                if name.starts_with('.') || name.chars().any(char::is_control) {
                    continue;
                }
                let path = directory.join(name);
                let Ok(metadata) = root.symlink_metadata(&path) else {
                    map.truncated = true;
                    continue;
                };
                if is_link(&metadata) {
                    continue;
                }
                if metadata.is_dir() && !skip_directory(name) {
                    if depth < MAX_DEPTH {
                        subdirs.push(path);
                    } else {
                        map.truncated = true;
                    }
                } else if metadata.is_file() {
                    if let Some(language) = Language::for_path(&path) {
                        files.push((path, language));
                    }
                }
            }
            files.sort_unstable_by(|(a, _), (b, _)| a.cmp(b));
            for (path, language) in files {
                let cap = bytes_left.min(MAX_SOURCE_BYTES + 1);
                if cap == 0 || Instant::now() >= deadline {
                    map.truncated = true;
                    return Ok(map);
                }
                let Ok(source) = read_source(&root, &path, cap, &mut bytes_left) else {
                    map.truncated = true;
                    continue;
                };
                let Some(source) = source else {
                    map.truncated = true;
                    continue;
                };
                let (symbols, truncated) = index.symbols(language, &source);
                map.truncated |= truncated;
                if !symbols.is_empty() && !map.add_file(&path, symbols) {
                    return Ok(map);
                }
            }
            if entries_left == 0 {
                map.truncated = true;
                break;
            }
            subdirs.sort_unstable();
            pending.extend(subdirs.into_iter().rev().map(|path| (path, depth + 1)));
        }
        Ok(map)
    }

    pub fn as_str(&self) -> &str {
        &self.text
    }

    pub fn is_truncated(&self) -> bool {
        self.truncated
    }

    fn add_file(&mut self, path: &Path, symbols: Vec<String>) -> bool {
        let path = path
            .to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/");
        let header = format!("{path}:\n");
        let mut lines = symbols.into_iter().peekable();
        if self.text.len() + header.len() + lines.peek().map_or(0, |line| line.len() + 3)
            > MAX_MAP_BYTES
        {
            self.truncated = true;
            return false;
        }
        self.text.push_str(&header);
        for line in lines {
            if self.text.len() + line.len() + 3 > MAX_MAP_BYTES {
                self.truncated = true;
                return false;
            }
            self.text.push_str("  ");
            self.text.push_str(&line);
            self.text.push('\n');
        }
        true
    }
}

fn skip_directory(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "node_modules" | "target" | "dist" | "build" | "coverage" | "vendor"
    )
}

fn is_link(metadata: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use cap_std::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    metadata.is_symlink()
}

fn read_source(
    root: &Dir,
    path: &Path,
    cap: usize,
    bytes_left: &mut usize,
) -> io::Result<Option<String>> {
    let metadata = root.symlink_metadata(path)?;
    if !metadata.is_file() || is_link(&metadata) || metadata.len() >= cap as u64 {
        return Ok(None);
    }
    // Metadata is only a filter; the directory handle also constrains resolution at open time.
    let file = root.open(path)?;
    let opened = file.metadata()?;
    if !opened.is_file() || is_link(&opened) || opened.len() >= cap as u64 {
        return Ok(None);
    }
    let mut bytes = Vec::new();
    let result = file.take(cap as u64).read_to_end(&mut bytes);
    *bytes_left -= bytes.len();
    result?;
    Ok((bytes.len() < cap)
        .then(|| String::from_utf8(bytes).ok())
        .flatten())
}

#[derive(Clone, Copy)]
enum Language {
    Rust,
    TypeScript,
    Tsx,
}

impl Language {
    fn for_path(path: &Path) -> Option<Self> {
        match path.extension()?.to_str()? {
            "rs" => Some(Self::Rust),
            "ts" | "mts" | "cts" => Some(Self::TypeScript),
            "tsx" => Some(Self::Tsx),
            _ => None,
        }
    }
}

struct Index {
    rust: Parser,
    ts: Parser,
    tsx: Parser,
}

impl Index {
    fn new() -> Result<Self, tree_sitter::LanguageError> {
        fn parser(language: tree_sitter::Language) -> Result<Parser, tree_sitter::LanguageError> {
            let mut parser = Parser::new();
            parser.set_language(&language)?;
            Ok(parser)
        }
        Ok(Self {
            rust: parser(tree_sitter_rust::LANGUAGE.into())?,
            ts: parser(tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into())?,
            tsx: parser(tree_sitter_typescript::LANGUAGE_TSX.into())?,
        })
    }

    fn symbols(&mut self, language: Language, source: &str) -> (Vec<String>, bool) {
        let parser = match language {
            Language::Rust => &mut self.rust,
            Language::TypeScript => &mut self.ts,
            Language::Tsx => &mut self.tsx,
        };
        let deadline = Instant::now() + Duration::from_millis(100);
        let mut progress = |_: &ParseState| Instant::now() >= deadline;
        let tree = parser.parse_with_options(
            &mut |offset, _| source.as_bytes().get(offset..).unwrap_or_default(),
            None,
            Some(ParseOptions::new().progress_callback(&mut progress)),
        );
        let Some(tree) = tree else {
            parser.reset();
            return (Vec::new(), true);
        };
        let root = tree.root_node();
        let mut outline = Outline {
            source,
            lines: Vec::new(),
            truncated: root.has_error(),
        };
        outline.scope(root, language, 0);
        (outline.lines, outline.truncated)
    }
}

struct Outline<'a> {
    source: &'a str,
    lines: Vec<String>,
    truncated: bool,
}

impl<'a> Outline<'a> {
    fn full(&self) -> bool {
        self.lines.len() >= MAX_SYMBOLS_PER_FILE
    }

    fn text(&self, node: Node<'_>) -> &'a str {
        self.source.get(node.byte_range()).unwrap_or_default()
    }

    fn scope(&mut self, root: Node<'_>, language: Language, depth: usize) {
        let mut doc = String::new();
        let mut cursor = root.walk();
        let first_line = self.lines.len();
        for node in root.named_children(&mut cursor) {
            if self.full() {
                self.truncated = true;
                break;
            }
            if matches!(language, Language::Rust) && node.child_by_field_name("inner").is_some() {
                let text = self.text(node);
                if let Some(summary) = text
                    .strip_prefix("//!")
                    .map(str::trim)
                    .or_else(|| block_doc(text, "/*!"))
                {
                    if self.lines.len() == first_line {
                        self.push(
                            &"  ".repeat(depth),
                            &format!("//! {}", compact(summary, MAX_DOC_BYTES)),
                            "",
                        );
                    }
                    continue;
                }
            }
            if self.collect_doc(node, language, &mut doc) {
                continue;
            }
            match language {
                Language::Rust => self.rust(node, &doc, depth),
                _ => self.typescript(node, "", &doc),
            }
            doc.clear();
        }
    }

    fn collect_doc(&self, node: Node<'_>, language: Language, doc: &mut String) -> bool {
        if matches!(language, Language::Rust) && node.kind() == "attribute_item" {
            return true;
        }
        if !matches!(node.kind(), "comment" | "line_comment" | "block_comment") {
            return false;
        }
        let text = self.text(node);
        let summary = if text.starts_with("/**") && !text.starts_with("/***") {
            block_doc(text, "/**")
        } else if matches!(language, Language::Rust) && !text.starts_with("////") {
            text.strip_prefix("///").map(str::trim)
        } else {
            None
        };
        match summary {
            Some(summary) if doc.is_empty() => *doc = compact(summary, MAX_DOC_BYTES),
            None => doc.clear(),
            _ => {}
        }
        true
    }

    fn header(&self, node: Node<'_>) -> &'a str {
        let end = node
            .child_by_field_name("body")
            .map_or(node.end_byte(), |body| body.start_byte());
        self.source
            .get(node.start_byte()..end)
            .unwrap_or_default()
            .trim()
            .trim_end_matches(';')
    }

    fn ts_header(&self, node: Node<'_>) -> Cow<'a, str> {
        let header = self.header(node);
        let start = node.start_byte();
        let end = start + header.len();
        let mut cursor = node.walk();
        let mut written = start;
        let mut signature = String::new();
        'header: loop {
            let child = cursor.node();
            if child.start_byte() >= end {
                break;
            }
            if child.end_byte() <= end && ts_expression(child) {
                signature.push_str(
                    self.source
                        .get(written..child.start_byte())
                        .unwrap_or_default(),
                );
                signature.push('…');
                written = child.end_byte();
            } else if cursor.goto_first_child() {
                continue;
            }
            while !cursor.goto_next_sibling() {
                if !cursor.goto_parent() {
                    break 'header;
                }
            }
        }
        if signature.is_empty() {
            return Cow::Borrowed(header);
        }
        signature.push_str(header.get(written - start..).unwrap_or_default());
        Cow::Owned(signature)
    }

    fn push(&mut self, indent: &str, signature: &str, doc: &str) {
        if self.full() {
            self.truncated = true;
            return;
        }
        let signature = compact(signature, MAX_SIGNATURE_BYTES);
        if !signature.is_empty() {
            let mut line = format!("{indent}{signature}");
            if !doc.is_empty() {
                line.push_str(" — ");
                line.push_str(doc);
            }
            self.lines.push(line);
        }
    }

    fn rust(&mut self, node: Node<'_>, doc: &str, depth: usize) {
        let indent = "  ".repeat(depth);
        match node.kind() {
            "function_item"
            | "function_signature_item"
            | "struct_item"
            | "enum_item"
            | "union_item"
            | "type_item" => {
                self.push(&indent, self.header(node), doc);
            }
            "mod_item" => {
                self.push(&indent, self.header(node), doc);
                if let Some(body) = node.child_by_field_name("body") {
                    if depth < MAX_DEPTH {
                        self.scope(body, Language::Rust, depth + 1);
                    } else {
                        self.truncated = true;
                    }
                }
            }
            "trait_item" | "impl_item" => {
                let trait_item = node.kind() == "trait_item";
                let in_trait = trait_item || node.child_by_field_name("trait").is_some();
                let Some(body) = node.child_by_field_name("body") else {
                    return;
                };
                let mut heading = false;
                if trait_item {
                    self.push(&indent, self.header(node), doc);
                    heading = true;
                }
                let mut method_doc = String::new();
                let mut cursor = body.walk();
                for method in body.named_children(&mut cursor) {
                    if self.collect_doc(method, Language::Rust, &mut method_doc) {
                        continue;
                    }
                    if matches!(method.kind(), "function_item" | "function_signature_item")
                        && (in_trait || self.modifier(method, "visibility_modifier") == Some("pub"))
                    {
                        if !heading {
                            self.push(&indent, self.header(node), doc);
                            heading = true;
                        }
                        self.push(&format!("{indent}  "), self.header(method), &method_doc);
                    }
                    method_doc.clear();
                    if self.full() {
                        self.truncated = true;
                        break;
                    }
                }
            }
            _ => {}
        }
    }

    fn modifier(&self, node: Node<'_>, kind: &str) -> Option<&'a str> {
        let mut cursor = node.walk();
        let modifier = node
            .named_children(&mut cursor)
            .find(|child| child.kind() == kind)?;
        Some(self.text(modifier))
    }

    fn typescript(&mut self, node: Node<'_>, prefix: &str, doc: &str) {
        match node.kind() {
            "export_statement" => {
                let inner = node
                    .child_by_field_name("declaration")
                    .or_else(|| node.child_by_field_name("value"));
                if let Some(inner) = inner {
                    let prefix = if self.text(node).split_whitespace().nth(1) == Some("default") {
                        "export default "
                    } else {
                        "export "
                    };
                    self.typescript(inner, prefix, doc);
                }
            }
            "ambient_declaration" => {
                let mut cursor = node.walk();
                for inner in node.named_children(&mut cursor) {
                    if inner.kind() != "ambient_declaration" {
                        self.typescript(inner, &format!("{prefix}declare "), doc);
                    }
                }
            }
            "function_declaration"
            | "function_signature"
            | "function_expression"
            | "generator_function_declaration"
            | "type_alias_declaration"
            | "enum_declaration" => {
                self.push("", &format!("{prefix}{}", self.ts_header(node)), doc);
            }
            "class_declaration"
            | "abstract_class_declaration"
            | "class"
            | "interface_declaration" => {
                self.push("", &format!("{prefix}{}", self.ts_header(node)), doc);
                let Some(body) = node.child_by_field_name("body") else {
                    return;
                };
                let mut method_doc = String::new();
                let mut cursor = body.walk();
                for method in body.named_children(&mut cursor) {
                    if self.collect_doc(method, Language::TypeScript, &mut method_doc) {
                        continue;
                    }
                    let private = method
                        .child_by_field_name("name")
                        .is_some_and(|name| name.kind() == "private_property_identifier")
                        || matches!(
                            self.modifier(method, "accessibility_modifier"),
                            Some("private" | "protected")
                        );
                    if !private
                        && matches!(
                            method.kind(),
                            "method_definition"
                                | "method_signature"
                                | "abstract_method_signature"
                                | "construct_signature"
                                | "call_signature"
                        )
                    {
                        self.push("  ", &self.ts_header(method), &method_doc);
                    }
                    method_doc.clear();
                    if self.full() {
                        self.truncated = true;
                        break;
                    }
                }
            }
            "lexical_declaration" | "variable_declaration" => {
                let kind = node
                    .child_by_field_name("kind")
                    .map_or("var", |kind| self.text(kind));
                let mut cursor = node.walk();
                for decl in node.named_children(&mut cursor) {
                    let Some(value) = decl.child_by_field_name("value") else {
                        continue;
                    };
                    if matches!(
                        value.kind(),
                        "arrow_function" | "function_expression" | "generator_function"
                    ) {
                        let head = self
                            .source
                            .get(decl.start_byte()..value.start_byte())
                            .unwrap_or_default();
                        self.push(
                            "",
                            &format!("{prefix}{kind} {head}{}", self.ts_header(value)),
                            doc,
                        );
                    }
                    if self.full() {
                        self.truncated = true;
                        break;
                    }
                }
            }
            _ => {}
        }
    }
}

fn ts_expression(node: Node<'_>) -> bool {
    matches!(
        node.kind(),
        "decorator" | "computed_property_name" | "statement_block" | "class_body"
    ) || node.parent().is_some_and(|parent| match parent.kind() {
        "required_parameter" | "optional_parameter" => {
            parent.child_by_field_name("value") == Some(node)
        }
        "assignment_pattern" | "object_assignment_pattern" => {
            parent.child_by_field_name("right") == Some(node)
        }
        "extends_clause" => {
            parent.child_by_field_name("value") == Some(node) && !qualified_name(node)
        }
        _ => false,
    })
}

fn qualified_name(mut node: Node<'_>) -> bool {
    while node.kind() == "member_expression" {
        if !node
            .child_by_field_name("property")
            .is_some_and(|property| property.kind() == "property_identifier")
        {
            return false;
        }
        let Some(object) = node.child_by_field_name("object") else {
            return false;
        };
        node = object;
    }
    node.kind() == "identifier"
}

fn block_doc<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    text.strip_prefix(prefix)?
        .strip_suffix("*/")?
        .lines()
        .map(|line| line.trim().trim_start_matches('*').trim())
        .find(|line| !line.is_empty())
}

fn compact(text: &str, cap: usize) -> String {
    let mut output = String::new();
    for word in text.split_whitespace() {
        if output.len() + word.len() + usize::from(!output.is_empty()) > cap {
            if output.is_empty() {
                for ch in word.chars().take_while(|ch| !ch.is_control()) {
                    if output.len() + ch.len_utf8() > cap {
                        break;
                    }
                    output.push(ch);
                }
            }
            output.push('…');
            break;
        }
        if !output.is_empty() {
            output.push(' ');
        }
        output.extend(word.chars().filter(|ch| !ch.is_control()));
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn extracts_rust_items_and_public_api_without_bodies() -> Result<(), RepoMapError> {
        let mut index = Index::new()?;
        let (lines, truncated) = index.symbols(
            Language::Rust,
            r#"
//! Menu module.
/// A café menu.
#[derive(Debug)]
pub struct Menu<T> { hidden: T }
pub enum Size { Small, Large }
pub trait Order {
    /// Submit an order.
    fn submit(&self, size: Size) -> bool;
    fn default_order(&self) { body_only(); }
}
impl<T> Menu<T> {
    pub async fn new(value: T) -> Self { body_only(); todo!() }
    fn hidden(&self) {}
    pub(crate) fn crate_only(&self) {}
}
pub fn top(value: i32) -> i32 { fn nested() {} value }
"#,
        );
        assert!(!truncated);
        assert_eq!(
            lines,
            [
                "//! Menu module.",
                "pub struct Menu<T> — A café menu.",
                "pub enum Size",
                "pub trait Order",
                "  fn submit(&self, size: Size) -> bool — Submit an order.",
                "  fn default_order(&self)",
                "impl<T> Menu<T>",
                "  pub async fn new(value: T) -> Self",
                "pub fn top(value: i32) -> i32",
            ]
        );
        Ok(())
    }

    #[test]
    fn preserves_inline_module_scope_and_docs_without_function_bodies() -> Result<(), RepoMapError>
    {
        let (lines, truncated) = Index::new()?.symbols(
            Language::Rust,
            r#"
/// Public API.
pub mod api {
    //! Module overview.
    pub mod settings {
        /// Start Lain.
        pub fn start() { body_only(); }
    }
    mod separate;
}
"#,
        );
        assert!(!truncated);
        assert_eq!(
            lines,
            [
                "pub mod api — Public API.",
                "  //! Module overview.",
                "  pub mod settings",
                "    pub fn start() — Start Lain.",
                "  mod separate",
            ]
        );
        Ok(())
    }

    #[test]
    fn extracts_typescript_exports_methods_signatures_and_jsdoc() -> Result<(), RepoMapError> {
        let mut index = Index::new()?;
        let (lines, truncated) = index.symbols(
            Language::TypeScript,
            r#"
/** Caller contract. */
export interface Task {
    /** Execute it. */
    run(input: string): Promise<void>;
}
export default class Job implements Task {
    public async run(input: string): Promise<void> { bodyOnly(); }
    protected internal(): void {}
    private hidden(): void {}
    #secret(): void {}
}
export declare function ready(): boolean;
export const format = (value: string): string => value.toUpperCase();
export function build(init: () => void = () => { bodyOnly(); }): Job { return new Job(); }
export enum State { Active, Done }
/** Public task handle. */
export type Handle<T> = Promise<T>;
"#,
        );
        assert!(!truncated);
        assert_eq!(
            lines,
            [
                "export interface Task — Caller contract.",
                "  run(input: string): Promise<void> — Execute it.",
                "export default class Job implements Task",
                "  public async run(input: string): Promise<void>",
                "export declare function ready(): boolean",
                "export const format = (value: string): string =>",
                "export function build(init: () => void = …): Job",
                "export enum State",
                "export type Handle<T> = Promise<T> — Public task handle.",
            ]
        );
        Ok(())
    }

    #[test]
    fn hides_expressions_embedded_in_typescript_headers() -> Result<(), RepoMapError> {
        let (lines, truncated) = Index::new()?.symbols(
            Language::TypeScript,
            r#"
@decorate(() => { bodyOnly(); })
export class A extends (() => { bodyOnly(); return Base; })() implements Task {
    [(() => { bodyOnly(); return "name"; })()]() {}
}
export class B extends api.Base<string> {}
"#,
        );
        assert!(!truncated);
        assert!(lines
            .iter()
            .any(|line| line.contains("class A extends … implements Task")));
        assert!(lines
            .iter()
            .any(|line| line == "export class B extends api.Base<string>"));
        assert!(!lines.join("\n").contains("bodyOnly"));
        Ok(())
    }

    #[test]
    #[cfg(unix)]
    fn rechecks_the_workspace_boundary_when_an_ancestor_changes() -> Result<(), RepoMapError> {
        let workspace = tempfile::tempdir()?;
        let outside = tempfile::tempdir()?;
        fs::create_dir(workspace.path().join("src"))?;
        fs::write(workspace.path().join("src/site.rs"), "pub fn inside() {}")?;
        fs::write(outside.path().join("site.rs"), "pub fn outside() {}")?;

        let root = Dir::open_ambient_dir(workspace.path(), ambient_authority())?;
        let source = Path::new("src/site.rs");
        assert!(root.symlink_metadata(source)?.is_file());
        fs::rename(workspace.path().join("src"), workspace.path().join("old"))?;
        std::os::unix::fs::symlink(outside.path(), workspace.path().join("src"))?;

        let mut bytes_left = MAX_TOTAL_BYTES;
        let result = read_source(&root, source, MAX_SOURCE_BYTES, &mut bytes_left);
        assert!(result.is_err() || matches!(result, Ok(None)));
        assert_eq!(bytes_left, MAX_TOTAL_BYTES);
        Ok(())
    }

    #[test]
    fn walks_only_supported_workspace_sources_and_uses_sorted_relative_paths(
    ) -> Result<(), RepoMapError> {
        let root = tempfile::tempdir()?;
        fs::create_dir(root.path().join("src"))?;
        fs::create_dir(root.path().join("node_modules"))?;
        fs::write(root.path().join("src/z.rs"), "pub fn z() { body_only(); }")?;
        fs::write(
            root.path().join("src/a.tsx"),
            "export const View = () => <p>body only</p>;",
        )?;
        fs::write(
            root.path().join("node_modules/b.ts"),
            "function vendor() {}",
        )?;
        fs::write(root.path().join(".hidden.rs"), "fn hidden() {}")?;
        fs::write(
            root.path().join("oversized.rs"),
            " ".repeat(MAX_SOURCE_BYTES + 1),
        )?;
        #[cfg(unix)]
        {
            let outside = tempfile::tempdir()?;
            fs::write(outside.path().join("private.rs"), "fn outside() {}")?;
            std::os::unix::fs::symlink(outside.path(), root.path().join("escape"))?;
            std::os::unix::fs::symlink(
                outside.path().join("private.rs"),
                root.path().join("linked.rs"),
            )?;
            let map = RepoMap::scan(root.path())?;
            assert!(!map.as_str().contains("outside"));
        }
        let map = RepoMap::scan(root.path())?;
        assert!(map.is_truncated());
        assert_eq!(
            map.as_str(),
            "src/a.tsx:\n  export const View = () =>\nsrc/z.rs:\n  pub fn z()\n"
        );
        Ok(())
    }
}
