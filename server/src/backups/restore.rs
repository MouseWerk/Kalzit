//! `kalzit backup restore <file>`: puts a backup back on a stopped server (docs/guide/backup.md,
//! "Restore from a Kalzit backup"). The only way a backup is restored; the API never does it.
//!
//! The server must be stopped (the data directory's lock is held exclusively throughout). An
//! encrypted backup is opened with the secrets key the server loads. The zip's entries are
//! checked before anything is written: only `kalzit.db`, `acme/...`, `plugins/...`, `kalzit.toml`
//! and `README.txt`, plain relative paths. Then `kalzit.db` replaces the SQLite database (its WAL
//! files go first), `acme/` and `plugins/` replace those folders (the old ones are kept next to
//! them as `<name>.before-restore-<time>`), and `kalzit.toml` is written next to the data as
//! `kalzit.toml.restored` for the operator to compare: the configuration in force is never
//! overwritten.

use std::io::{self, Read};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};

use crate::config::Config;
use crate::secrets::Keyring;

/// What a restore did, for the command's output.
pub struct Restored {
    pub database: bool,
    pub folders: Vec<String>,
    pub config_copy: Option<PathBuf>,
    pub kept: Vec<PathBuf>,
}

impl std::fmt::Display for Restored {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.database {
            writeln!(f, "restored the database")?;
        } else {
            writeln!(f, "the backup holds no database (PostgreSQL: restore it with pg_restore)")?;
        }
        for folder in &self.folders {
            writeln!(f, "restored {folder}/")?;
        }
        for kept in &self.kept {
            writeln!(f, "kept the previous folder as {}", kept.display())?;
        }
        if let Some(copy) = &self.config_copy {
            writeln!(f, "wrote the backup's configuration to {}; compare it with yours", copy.display())?;
        }
        write!(f, "start Kalzit again")
    }
}

/// Whether `name` is an entry a backup may hold.
fn allowed_entry(name: &str) -> bool {
    let plain = !name.is_empty()
        && !name.starts_with('/')
        && !name.contains('\\')
        && !name.contains(':')
        && name.split('/').all(|part| !part.is_empty() && part != "." && part != "..");
    plain
        && (matches!(name, "kalzit.db" | "kalzit.toml" | "README.txt")
            || name.starts_with("acme/")
            || name.starts_with("plugins/"))
}

/// Opens `file` as a zip: decrypted into `work` first when it is encrypted.
fn open_zip(file: &Path, work: &Path, keyring: Option<&Keyring>) -> Result<zip::ZipArchive<std::fs::File>> {
    let mut head = [0u8; 10];
    let read = std::fs::File::open(file)
        .with_context(|| format!("opening {}", file.display()))?
        .read(&mut head)
        .context("reading the backup")?;
    let path = if super::archive::is_encrypted(&head[..read]) {
        let Some(keyring) = keyring else { bail!("the backup is encrypted, and no secrets key is loaded") };
        let plain = work.join("backup.zip");
        let mut input = io::BufReader::new(std::fs::File::open(file)?);
        let mut output = io::BufWriter::new(std::fs::File::create(&plain)?);
        super::archive::decrypt(keyring, &mut input, &mut output).context("decrypting the backup")?;
        io::Write::flush(&mut output)?;
        plain
    } else {
        file.to_path_buf()
    };
    zip::ZipArchive::new(std::fs::File::open(&path)?).context("reading the backup as a zip file")
}

fn extract_to(zip: &mut zip::ZipArchive<std::fs::File>, index: usize, target: &Path) -> Result<()> {
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut entry = zip.by_index(index)?;
    let mut out = std::fs::File::create(target).with_context(|| format!("writing {}", target.display()))?;
    io::copy(&mut entry, &mut out)?;
    out.sync_all()?;
    Ok(())
}

/// Restores `file` into the data directory of `config`. `now_ms` names the kept folders.
pub fn restore(config: &Config, file: &Path, now_ms: i64) -> Result<Restored> {
    let data_dir = &config.paths.data_dir;
    let _lock = crate::secrets::hold_exclusive(data_dir)?;
    let keyring = Keyring::load(data_dir).ok();
    let work = data_dir.join("backup-work").join(format!("restore-{now_ms}"));
    std::fs::create_dir_all(&work).context("making the work folder")?;
    let result = restore_in(config, file, now_ms, &work, keyring.as_ref());
    let _ = std::fs::remove_dir_all(&work);
    result
}

fn restore_in(config: &Config, file: &Path, now_ms: i64, work: &Path, keyring: Option<&Keyring>) -> Result<Restored> {
    let data_dir = &config.paths.data_dir;
    let mut zip = open_zip(file, work, keyring)?;
    let mut names = Vec::new();
    for i in 0..zip.len() {
        let entry = zip.by_index(i)?;
        let name = entry.name().map_err(|e| anyhow::anyhow!("reading the backup's entries: {e}"))?.to_string();
        if entry.is_dir() {
            continue;
        }
        if !allowed_entry(&name) || entry.is_symlink() {
            bail!("the backup holds an entry Kalzit does not restore: {name:?}");
        }
        names.push((i, name));
    }
    let has_db = names.iter().any(|(_, n)| n == "kalzit.db");
    let db_file = crate::db::sqlite_file(&config.database_url());
    if has_db && db_file.is_none() {
        bail!("the backup holds a SQLite database, but this server is configured for PostgreSQL");
    }
    let mut restored = Restored { database: false, folders: Vec::new(), config_copy: None, kept: Vec::new() };
    // Everything is unpacked into the work folder first, so a broken entry changes nothing.
    let staged = work.join("staged");
    for (i, name) in &names {
        extract_to(&mut zip, *i, &staged.join(name))?;
    }
    if let (true, Some(db)) = (has_db, db_file) {
        crate::updates::install::restore_database(&staged.join("kalzit.db"), &db).context("restoring the database")?;
        restored.database = true;
    }
    for folder in ["acme", "plugins"] {
        let from = staged.join(folder);
        if !from.is_dir() {
            continue;
        }
        // The plugins go to the configured plugin folder (`paths.plugins_dir`), the old ones are
        // kept beside it.
        let to = if folder == "plugins" { config.plugins_dir() } else { data_dir.join(folder) };
        if to.exists() {
            let kept = to.with_file_name(format!(
                "{}.before-restore-{now_ms}",
                to.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| folder.to_string())
            ));
            std::fs::rename(&to, &kept).with_context(|| format!("moving {} aside", to.display()))?;
            restored.kept.push(kept);
        }
        if folder == "plugins" {
            // Outside the data directory nothing private is inherited: the folder itself is.
            crate::data_dir::create_private_dir(&to).with_context(|| format!("creating {}", to.display()))?;
        }
        copy_dir(&from, &to)?;
        restored.folders.push(folder.to_string());
    }
    let toml = staged.join("kalzit.toml");
    if toml.is_file() {
        let copy = data_dir.join("kalzit.toml.restored");
        std::fs::copy(&toml, &copy).context("writing kalzit.toml.restored")?;
        restored.config_copy = Some(copy);
    }
    Ok(restored)
}

/// Copies a folder: new files take the data directory's private permissions, like a restore by
/// hand (docs/guide/backup.md: copy, do not move).
fn copy_dir(from: &Path, to: &Path) -> io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_backup_entries_are_restored() {
        for ok in ["kalzit.db", "kalzit.toml", "README.txt", "acme/certificate.enc", "plugins/packages/a/b.js"] {
            assert!(allowed_entry(ok), "{ok}");
        }
        for bad in
            ["../kalzit.db", "/etc/passwd", "acme/../../x", "secrets.key", "C:/x", "acme\\x", "plugins//x", "updates/x"]
        {
            assert!(!allowed_entry(bad), "{bad}");
        }
    }
}
