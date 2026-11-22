use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::OsString,
    io,
    path::{Component, Path, PathBuf},
};

use sha2::{Digest, Sha256};

use crate::workspace::{self, Entry};

pub type MerkleHash = [u8; 32];

pub(crate) fn leaf_hash(bytes: &[u8]) -> MerkleHash {
    Sha256::digest(bytes).into()
}

#[derive(Debug, Clone)]
struct Node {
    hash: MerkleHash,
    children: Option<BTreeMap<OsString, Node>>,
}

impl Node {
    fn directory() -> Self {
        Self {
            hash: [0; 32],
            children: Some(BTreeMap::new()),
        }
    }

    fn directory_mut(&mut self, path: &Path) -> &mut Self {
        let mut node = self;
        for name in path.iter() {
            node = node
                .children
                .get_or_insert_with(BTreeMap::new)
                .entry(name.into())
                .or_insert_with(Self::directory);
        }
        node
    }

    fn rehash(&mut self) {
        if let Some(children) = &mut self.children {
            let mut hash = Sha256::new();
            hash.update(b"directory\0");
            for (name, child) in children {
                child.rehash();
                let name = name.as_encoded_bytes();
                hash.update((name.len() as u64).to_le_bytes());
                hash.update(name);
                hash.update([u8::from(child.children.is_some())]);
                hash.update(child.hash);
            }
            self.hash = hash.finalize().into();
        }
    }
}

#[derive(Debug, Clone)]
pub struct MerkleTree {
    root: Node,
    truncated: bool,
}

impl MerkleTree {
    pub fn build(root: impl AsRef<Path>) -> io::Result<Self> {
        let mut tree = Self {
            root: Node::directory(),
            truncated: false,
        };
        tree.truncated = workspace::walk(
            root,
            |_| true,
            |entry| {
                match entry {
                    Entry::Directory(path) => {
                        tree.root.directory_mut(path);
                    }
                    Entry::File(path, bytes) => {
                        if let Some(name) = path.file_name() {
                            tree.root
                                .directory_mut(path.parent().unwrap_or_else(|| Path::new("")))
                                .children
                                .get_or_insert_with(BTreeMap::new)
                                .insert(
                                    name.into(),
                                    Node {
                                        hash: leaf_hash(bytes),
                                        children: None,
                                    },
                                );
                        }
                    }
                }
                true
            },
        )?;
        tree.root.rehash();
        Ok(tree)
    }

    pub fn root_hash(&self) -> MerkleHash {
        self.root.hash
    }
    pub fn is_truncated(&self) -> bool {
        self.truncated
    }

    pub fn hash_of(&self, path: impl AsRef<Path>) -> Option<MerkleHash> {
        let mut node = &self.root;
        for part in path.as_ref().components() {
            match part {
                Component::CurDir => {}
                Component::Normal(name) => node = node.children.as_ref()?.get(name)?,
                _ => return None,
            }
        }
        Some(node.hash)
    }

    pub fn diff(&self, new: &Self) -> Vec<PathBuf> {
        self.diff_counted(new).0
    }

    fn diff_counted(&self, new: &Self) -> (Vec<PathBuf>, usize) {
        let mut dirty = Vec::new();
        let mut visited = 0;
        diff_nodes(
            Some(&self.root),
            Some(&new.root),
            Path::new(""),
            &mut dirty,
            &mut visited,
        );
        (dirty, visited)
    }
}

fn diff_nodes(
    old: Option<&Node>,
    new: Option<&Node>,
    path: &Path,
    dirty: &mut Vec<PathBuf>,
    visited: &mut usize,
) {
    *visited += 1;
    if old
        .zip(new)
        .is_some_and(|(a, b)| a.hash == b.hash && a.children.is_some() == b.children.is_some())
    {
        return;
    }
    if old.is_some_and(|n| n.children.is_none()) || new.is_some_and(|n| n.children.is_none()) {
        dirty.push(path.into());
    }
    let old_children = old.and_then(|n| n.children.as_ref());
    let new_children = new.and_then(|n| n.children.as_ref());
    let names: BTreeSet<_> = old_children
        .into_iter()
        .chain(new_children)
        .flat_map(|c| c.keys())
        .collect();
    for name in names {
        diff_nodes(
            old_children.and_then(|c| c.get(name)),
            new_children.and_then(|c| c.get(name)),
            &path.join(name),
            dirty,
            visited,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn dirty_file_changes_only_ancestor_hashes_and_prunes_siblings(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let root = tempfile::tempdir()?;
        fs::create_dir_all(root.path().join("src/nested"))?;
        fs::create_dir(root.path().join("sibling"))?;
        fs::write(root.path().join("src/nested/a.rs"), "pub fn before() {}")?;
        for i in 0..50 {
            fs::write(root.path().join(format!("sibling/{i}.txt")), "stable")?;
        }
        let old = MerkleTree::build(root.path())?;
        assert!(!old.is_truncated());
        fs::write(root.path().join("src/nested/a.rs"), "pub fn after() {}")?;
        let new = MerkleTree::build(root.path())?;
        assert_eq!(old.diff(&new), vec![PathBuf::from("src/nested/a.rs")]);
        for path in ["", "src", "src/nested", "src/nested/a.rs"] {
            assert_ne!(old.hash_of(path), new.hash_of(path));
        }
        assert_ne!(old.root_hash(), new.root_hash());
        assert_eq!(old.hash_of("sibling"), new.hash_of("sibling"));
        assert_eq!(old.hash_of("sibling/0.txt"), new.hash_of("sibling/0.txt"));
        let (dirty, visited) = old.diff_counted(&new);
        assert_eq!(dirty.len(), 1);
        assert_eq!(visited, 5);
        let identical = MerkleTree::build(root.path())?;
        assert_eq!(new.diff_counted(&identical), (vec![], 1));
        Ok(())
    }

    #[test]
    fn additions_removals_type_changes_and_empty_trees() -> Result<(), Box<dyn std::error::Error>> {
        let root = tempfile::tempdir()?;
        let empty = MerkleTree::build(root.path())?;
        assert_eq!(empty.hash_of("."), Some(empty.root_hash()));
        assert!(empty.hash_of("missing").is_none());
        assert!(empty.hash_of("../escape").is_none());
        fs::write(root.path().join("gone.txt"), "gone")?;
        fs::create_dir(root.path().join("nested"))?;
        fs::write(root.path().join("nested/a.bin"), [0, 255, 1])?;
        let old = MerkleTree::build(root.path())?;
        assert_eq!(
            empty.diff(&old),
            vec![PathBuf::from("gone.txt"), PathBuf::from("nested/a.bin")]
        );
        fs::remove_file(root.path().join("gone.txt"))?;
        fs::write(root.path().join("added.md"), "added")?;
        let new = MerkleTree::build(root.path())?;
        assert_eq!(
            old.diff(&new),
            vec![PathBuf::from("added.md"), PathBuf::from("gone.txt")]
        );
        fs::remove_dir_all(root.path().join("nested"))?;
        fs::write(root.path().join("nested"), "now a file")?;
        let changed = MerkleTree::build(root.path())?;
        assert_eq!(
            new.diff(&changed),
            vec![PathBuf::from("nested"), PathBuf::from("nested/a.bin")]
        );
        assert!(MerkleTree::build(root.path().join("missing")).is_err());
        Ok(())
    }

    #[test]
    fn hashes_are_sorted_and_follow_workspace_filters_and_caps(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let a = tempfile::tempdir()?;
        let b = tempfile::tempdir()?;
        for (root, names) in [
            (a.path(), ["z.txt", "a.txt"]),
            (b.path(), ["a.txt", "z.txt"]),
        ] {
            for name in names {
                fs::write(root.join(name), name)?;
            }
            for directory in [
                ".hidden",
                "target",
                "node_modules",
                "vendor",
                "dist",
                "build",
                "coverage",
            ] {
                fs::create_dir(root.join(directory))?;
                fs::write(root.join(directory).join("ignored.rs"), "ignored")?;
            }
            fs::write(root.join(".secret"), "hidden")?;
        }
        let first = MerkleTree::build(a.path())?;
        assert_eq!(first.root_hash(), MerkleTree::build(b.path())?.root_hash());
        assert!(first.hash_of("target").is_none());
        assert!(first.hash_of(".secret").is_none());
        fs::write(
            a.path().join("big.bin"),
            vec![0; crate::workspace::MAX_SOURCE_BYTES + 1],
        )?;
        let limited = MerkleTree::build(a.path())?;
        assert!(limited.is_truncated());
        assert!(limited.hash_of("big.bin").is_none());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(b.path(), a.path().join("escape"))?;
            std::os::unix::fs::symlink(b.path().join("a.txt"), a.path().join("linked.txt"))?;
            let tree = MerkleTree::build(a.path())?;
            assert!(tree.hash_of("escape").is_none());
            assert!(tree.hash_of("linked.txt").is_none());
        }
        Ok(())
    }
}
