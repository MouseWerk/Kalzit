//! Folders on disk, for the command line: reading a set's folder and writing an export.
//!
//! A set's folder holds an optional `org.yaml` (the organization and the set) and the resource
//! files in any folders below it. Folders and files whose names start with `.` (a Git checkout's
//! `.git`) are skipped, so are files other than YAML and JSON. Links to folders are not followed.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};

use super::document::{self, MAX_FILE_BYTES, MAX_FILES, OrgFile, SourceFile};

/// A set's folder: what its `org.yaml` says, if it has one, and its files (`org.yaml` among them).
#[derive(Debug)]
pub struct SetFolder {
    pub org: Option<OrgFile>,
    pub files: Vec<SourceFile>,
}

fn org_file_in(dir: &Path) -> Option<PathBuf> {
    document::ORG_FILES.iter().map(|n| dir.join(n)).find(|p| p.is_file())
}

/// Reads one set's folder.
pub fn read_folder(dir: &Path) -> Result<SetFolder> {
    if !dir.is_dir() {
        bail!("{} is not a folder", dir.display());
    }
    let org = match org_file_in(dir) {
        Some(path) => {
            let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            let bytes = std::fs::read(&path).with_context(|| format!("reading {}", path.display()))?;
            let org = document::parse_org_file(&SourceFile { path: name, bytes })
                .map_err(|p| anyhow::anyhow!("{}: {}", path.display(), p.message))?;
            Some(org)
        }
        None => None,
    };
    Ok(SetFolder { org, files: read_files(dir)? })
}

/// Every YAML and JSON file below `dir`, by path relative to it with `/`, in a stable order.
pub fn read_files(dir: &Path) -> Result<Vec<SourceFile>> {
    let mut out = Vec::new();
    walk(dir, "", &mut out)?;
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

fn walk(dir: &Path, prefix: &str, out: &mut Vec<SourceFile>) -> Result<()> {
    let entries = std::fs::read_dir(dir).with_context(|| format!("reading {}", dir.display()))?;
    for entry in entries {
        let entry = entry.with_context(|| format!("reading {}", dir.display()))?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let path = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
        if entry.file_type()?.is_dir() {
            walk(&entry.path(), &path, out)?;
            continue;
        }
        // A link to a file counts as the file; links to folders are skipped (no loops).
        if !document::is_resource_file(&name) || entry.path().is_dir() {
            continue;
        }
        if out.len() >= MAX_FILES {
            bail!("{} holds more than {MAX_FILES} files", dir.display());
        }
        let len = std::fs::metadata(entry.path())?.len();
        if len > MAX_FILE_BYTES as u64 {
            bail!("{} is larger than {MAX_FILE_BYTES} bytes", entry.path().display());
        }
        let bytes = std::fs::read(entry.path()).with_context(|| format!("reading {}", entry.path().display()))?;
        out.push(SourceFile { path, bytes });
    }
    Ok(())
}

/// Writes `content` to `dir/relative` (a path with `/`), making its folders. A relative path that
/// would leave `dir` is refused: the paths come from the server.
pub fn write_file(dir: &Path, relative: &str, content: &str) -> Result<PathBuf> {
    let mut path = dir.to_path_buf();
    for part in relative.split('/') {
        if part.is_empty() || part == "." || part == ".." || part.starts_with('.') || part.contains(['\\', ':', '\0']) {
            bail!("{relative} is not a path inside the export folder");
        }
        path.push(part);
    }
    if !document::is_resource_file(relative) {
        bail!("{relative} is not a YAML or JSON file");
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).with_context(|| format!("creating {}", parent.display()))?;
    }
    std::fs::write(&path, content).with_context(|| format!("writing {}", path.display()))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_folder_is_read_with_its_org_file() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write_file(root, "org.yaml", "kind: Organization\nid: \"0199a0b1\"\nset: ops\n").unwrap();
        write_file(root, "roles/a.yaml", "kind: Role\nuid: a\nspec: {}\n").unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join(".git/config.yaml"), "ignored").unwrap();
        std::fs::write(root.join("README.md"), "ignored").unwrap();
        let folder = read_folder(root).unwrap();
        assert_eq!(folder.org.as_ref().unwrap().set.as_deref(), Some("ops"));
        let paths: Vec<&str> = folder.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["org.yaml", "roles/a.yaml"]);
        assert!(read_folder(&root.join("missing")).is_err());
    }

    #[test]
    fn writes_stay_inside_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        for bad in
            ["../x.yaml", "a//b.yaml", "/x.yaml", "a/./b.yaml", "c:x.yaml", "a\\..\\b.yaml", ".git/x.yaml", "a.exe"]
        {
            assert!(write_file(dir.path(), bad, "x").is_err(), "{bad}");
        }
        assert!(write_file(dir.path(), "a/b.yaml", "x").unwrap().is_file());
    }
}
