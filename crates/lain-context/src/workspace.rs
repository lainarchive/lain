use std::{
    io::{self, Read},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use cap_std::{
    ambient_authority,
    fs::{Dir, Metadata},
};

const MAX_ENTRIES: usize = 16_384;
pub(crate) const MAX_DEPTH: usize = 32;
pub(crate) const MAX_SOURCE_BYTES: usize = 256 * 1024;
pub(crate) const MAX_TOTAL_BYTES: usize = 16 * 1024 * 1024;
const MAX_SCAN_TIME: Duration = Duration::from_secs(5);

pub(crate) enum Entry<'a> {
    Directory(&'a Path),
    File(&'a Path, &'a [u8]),
}

pub(crate) fn walk(
    root: impl AsRef<Path>,
    include: impl Fn(&Path) -> bool,
    mut visit: impl FnMut(Entry<'_>) -> bool,
) -> io::Result<bool> {
    let root = Dir::open_ambient_dir(root, ambient_authority())?;
    let deadline = Instant::now() + MAX_SCAN_TIME;
    let mut truncated = false;
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
            Err(error) if depth == 0 => return Err(error),
            Err(_) => {
                truncated = true;
                continue;
            }
        };
        if !visit(Entry::Directory(&directory)) {
            return Ok(true);
        }
        let mut files = Vec::new();
        let mut subdirs = Vec::new();
        for entry in entries.take(entries_left) {
            if Instant::now() >= deadline {
                return Ok(true);
            }
            entries_left -= 1;
            let Ok(entry) = entry else {
                truncated = true;
                continue;
            };
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if name.starts_with('.') || name.chars().any(char::is_control) {
                continue;
            }
            let path = directory.join(name);
            let Ok(metadata) = root.symlink_metadata(&path) else {
                truncated = true;
                continue;
            };
            if is_link(&metadata) {
                continue;
            }
            if metadata.is_dir() && !skip_directory(name) {
                if depth < MAX_DEPTH {
                    subdirs.push(path);
                } else {
                    truncated = true;
                }
            } else if metadata.is_file() && include(&path) {
                files.push(path);
            }
        }
        files.sort_unstable();
        for path in files {
            let cap = bytes_left.min(MAX_SOURCE_BYTES + 1);
            if cap == 0 || Instant::now() >= deadline {
                return Ok(true);
            }
            let Ok(Some(bytes)) = read_bytes(&root, &path, cap, &mut bytes_left) else {
                truncated = true;
                continue;
            };
            if !visit(Entry::File(&path, &bytes)) {
                return Ok(true);
            }
        }
        if entries_left == 0 {
            return Ok(true);
        }
        subdirs.sort_unstable();
        pending.extend(subdirs.into_iter().rev().map(|path| (path, depth + 1)));
    }
    Ok(truncated)
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

pub(crate) fn read_bytes(
    root: &Dir,
    path: &Path,
    cap: usize,
    bytes_left: &mut usize,
) -> io::Result<Option<Vec<u8>>> {
    let metadata = root.symlink_metadata(path)?;
    if !metadata.is_file() || is_link(&metadata) || metadata.len() >= cap as u64 {
        return Ok(None);
    }
    // I open through the directory handle because metadata cannot prevent an ancestor swap.
    let file = root.open(path)?;
    let opened = file.metadata()?;
    if !opened.is_file() || is_link(&opened) || opened.len() >= cap as u64 {
        return Ok(None);
    }
    let mut bytes = Vec::new();
    let result = file.take(cap as u64).read_to_end(&mut bytes);
    *bytes_left -= bytes.len();
    result?;
    Ok((bytes.len() < cap).then_some(bytes))
}
