//! `kalzit-plugin`, the packaging tool for Kalzit plugins (docs/plugins/authoring.md).
//!
//! ```text
//! kalzit-plugin keygen --out <file>
//! kalzit-plugin package --manifest <template> (--file <package path>=<file>)... [--dir <directory>]...
//!                       [--platform <platform>]... --out <zip> [--manifest-out <file>]
//!                       [--key-file <file> | --unsigned]
//! kalzit-plugin sign --package <zip> --key-file <file> [--out <zip>]
//! kalzit-plugin attach-signature --package <zip> --signature <file> [--public-key <key>] [--out <zip>]
//! kalzit-plugin verify --package <zip> [--public-key <base64 or hex>]
//! ```
//!
//! `package` writes `[files]` with the SHA-256 of every file into the manifest, checks it as
//! Kalzit does, and signs it with the key from `--key-file` or the environment variable
//! `KALZIT_PLUGIN_SIGNING_KEY` (32 bytes, base64); `--unsigned` builds a package without a
//! signature. `--dir` adds every file below a directory under its relative path. `--platform`
//! keeps only those entries of `[binaries]`; `--manifest-out` also writes the exact manifest, for
//! signing elsewhere (`kalzit-sign sign-plugin-manifest`), whose signature
//! `attach-signature` adds to the package. Private keys are never printed.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use kalzit_plugin_api::signing;
use kalzit_plugin_tool as tool;
use zeroize::Zeroizing;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(text) => {
            println!("{text}");
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("kalzit-plugin: {e}");
            ExitCode::FAILURE
        }
    }
}

/// `--name value` options and `--flag` switches; repeated names keep every value.
struct Options(Vec<(String, Option<String>)>);

impl Options {
    fn parse(args: &[String], known: &[&str], flags: &[&str]) -> Result<Self, String> {
        let mut out = Vec::new();
        let mut rest = args.iter();
        while let Some(arg) = rest.next() {
            let name = arg.strip_prefix("--").ok_or_else(|| format!("unexpected argument {arg}"))?;
            if flags.contains(&name) {
                out.push((name.to_string(), None));
                continue;
            }
            if !known.contains(&name) {
                return Err(format!("unknown option --{name}"));
            }
            let value = rest.next().ok_or_else(|| format!("--{name} needs a value"))?;
            out.push((name.to_string(), Some(value.clone())));
        }
        Ok(Self(out))
    }

    fn one(&self, name: &str) -> Option<&str> {
        self.0.iter().rev().find(|(n, _)| n == name).and_then(|(_, v)| v.as_deref())
    }

    fn required(&self, name: &str) -> Result<&str, String> {
        self.one(name).ok_or_else(|| format!("--{name} is required"))
    }

    fn all(&self, name: &str) -> Vec<&str> {
        self.0.iter().filter(|(n, _)| n == name).filter_map(|(_, v)| v.as_deref()).collect()
    }

    fn flag(&self, name: &str) -> bool {
        self.0.iter().any(|(n, v)| n == name && v.is_none())
    }
}

fn run(args: &[String]) -> Result<String, String> {
    let (command, rest) = args.split_first().ok_or("usage: kalzit-plugin keygen|package|sign|verify ...")?;
    match command.as_str() {
        "keygen" => keygen(Path::new(Options::parse(rest, &["out"], &[])?.required("out")?)),
        "package" => {
            package(&Options::parse(rest, &["manifest", "file", "dir", "platform", "out", "key-file"], &["unsigned"])?)
        }
        "sign" => sign(&Options::parse(rest, &["package", "key-file", "out"], &[])?),
        "verify" => verify(&Options::parse(rest, &["package", "public-key"], &[])?),
        "attach-signature" => attach(&Options::parse(rest, &["package", "signature", "public-key", "out"], &[])?),
        other => Err(format!("unknown command {other}; use keygen, package, sign, attach-signature or verify")),
    }
}

fn read(path: &str) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|e| format!("{path}: {e}"))
}

/// The signing key from `--key-file`, else from the environment; `None` with `--unsigned`.
fn key(o: &Options, unsigned_allowed: bool) -> Result<Option<ed25519_dalek::SigningKey>, String> {
    if unsigned_allowed && o.flag("unsigned") {
        return Ok(None);
    }
    let text = match o.one("key-file") {
        Some(path) => Zeroizing::new(std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?),
        None => Zeroizing::new(std::env::var(tool::KEY_ENV).map_err(|_| {
            format!(
                "give --key-file, set {}{}",
                tool::KEY_ENV,
                if unsigned_allowed { " or pass --unsigned" } else { "" }
            )
        })?),
    };
    tool::signing_key(&text).map(Some)
}

fn keygen(out: &Path) -> Result<String, String> {
    let mut seed = Zeroizing::new([0u8; 32]);
    getrandom::fill(seed.as_mut()).map_err(|e| format!("the system random source failed: {e}"))?;
    let key = ed25519_dalek::SigningKey::from_bytes(&seed);
    let encoded = Zeroizing::new(BASE64.encode(seed.as_slice()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(out).map_err(|e| format!("{}: {e}", out.display()))?;
    if let Err(e) = restrict_to_owner(out) {
        // Nothing is written yet; a key file others could read is not left behind.
        drop(file);
        let _ = std::fs::remove_file(out);
        return Err(e);
    }
    std::io::Write::write_all(&mut file, encoded.as_bytes()).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    Ok(format!(
        "private key written to {} (keep it secret and keep an offline copy)\npublic key: {}\nkey id: {}",
        out.display(),
        BASE64.encode(key.verifying_key().as_bytes()),
        signing::key_id(&key.verifying_key())
    ))
}

/// The SID of the account this process runs as (`whoami /user`), not a name from the
/// environment, which another account could match.
#[cfg(windows)]
fn own_sid() -> Result<String, String> {
    let out = std::process::Command::new("whoami")
        .args(["/user", "/fo", "csv", "/nh"])
        .output()
        .map_err(|e| format!("running whoami: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout);
    text.trim()
        .rsplit(',')
        .next()
        .map(|s| s.trim().trim_matches('"').to_string())
        .filter(|s| {
            out.status.success() && s.starts_with("S-1-") && s[4..].bytes().all(|b| b.is_ascii_digit() || b == b'-')
        })
        .ok_or_else(|| "the account's SID could not be read".to_string())
}

/// Windows: the new key file keeps only an entry for the current account, by its SID (no
/// inherited ones).
#[cfg(windows)]
fn restrict_to_owner(path: &Path) -> Result<(), String> {
    let sid = own_sid()?;
    let status = std::process::Command::new("icacls")
        .arg(path)
        .args(["/inheritance:r", "/grant:r"])
        .arg(format!("*{sid}:F"))
        .stdout(std::process::Stdio::null())
        .status()
        .map_err(|e| format!("running icacls: {e}"))?;
    if status.success() { Ok(()) } else { Err(format!("icacls could not restrict {}", path.display())) }
}

#[cfg(not(windows))]
fn restrict_to_owner(_path: &Path) -> Result<(), String> {
    Ok(())
}

/// Every file below `dir`, by its path relative to `dir` with `/` between parts.
fn walk(dir: &Path, prefix: &str, out: &mut BTreeMap<String, Vec<u8>>) -> Result<(), String> {
    let mut entries: Vec<_> = std::fs::read_dir(dir)
        .map_err(|e| format!("{}: {e}", dir.display()))?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_symlink() {
            return Err(format!("{} is a link; packages hold plain files only", entry.path().display()));
        } else if kind.is_dir() {
            walk(&entry.path(), &path, out)?;
        } else {
            out.insert(path, std::fs::read(entry.path()).map_err(|e| format!("{}: {e}", entry.path().display()))?);
        }
    }
    Ok(())
}

fn package(o: &Options) -> Result<String, String> {
    let template = std::fs::read_to_string(o.required("manifest")?).map_err(|e| format!("the manifest: {e}"))?;
    let mut files = BTreeMap::new();
    for dir in o.all("dir") {
        walk(Path::new(dir), "", &mut files)?;
    }
    for spec in o.all("file") {
        let (path, local) = spec.split_once('=').ok_or_else(|| format!("{spec}: expected <package path>=<file>"))?;
        files.insert(path.to_string(), read(local)?);
    }
    let platforms: Vec<String> = o.all("platform").into_iter().map(str::to_string).collect();
    let key = key(o, true)?;
    let bytes = tool::package(&template, &files, &platforms, key.as_ref())?;
    let out = PathBuf::from(o.required("out")?);
    std::fs::write(&out, &bytes).map_err(|e| format!("{}: {e}", out.display()))?;
    if let Some(path) = o.one("manifest-out") {
        let text = tool::read(&bytes)?.manifest_text;
        std::fs::write(path, text).map_err(|e| format!("{path}: {e}"))?;
    }
    let checked = tool::verify(&bytes, key.as_ref().map(|k| k.verifying_key()).as_ref())?;
    Ok(format!("wrote {} ({} bytes): {checked}", out.display(), bytes.len()))
}

fn sign(o: &Options) -> Result<String, String> {
    let path = o.required("package")?;
    let key = key(o, false)?.ok_or("a key is required")?;
    let bytes = tool::sign(&read(path)?, &key)?;
    let out = o.one("out").unwrap_or(path);
    std::fs::write(out, &bytes).map_err(|e| format!("{out}: {e}"))?;
    Ok(format!("wrote {out}: {}", tool::verify(&bytes, Some(&key.verifying_key()))?))
}

fn attach(o: &Options) -> Result<String, String> {
    let path = o.required("package")?;
    let signature = read(o.required("signature")?)?;
    let key = o.one("public-key").map(tool::public_key).transpose()?;
    let bytes = tool::attach_signature(&read(path)?, &signature, key.as_ref())?;
    let out = o.one("out").unwrap_or(path);
    std::fs::write(out, &bytes).map_err(|e| format!("{out}: {e}"))?;
    Ok(format!("wrote {out}: {}", tool::verify(&bytes, key.as_ref())?))
}

fn verify(o: &Options) -> Result<String, String> {
    let bytes = read(o.required("package")?)?;
    let key = o.one("public-key").map(tool::public_key).transpose()?;
    tool::verify(&bytes, key.as_ref())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(text: &str) -> Vec<String> {
        text.split_whitespace().map(str::to_string).collect()
    }

    #[test]
    fn options_and_flags_are_parsed() {
        let o = Options::parse(&args("--file a=b --unsigned --file c=d"), &["file"], &["unsigned"]).unwrap();
        assert_eq!(o.all("file"), ["a=b", "c=d"]);
        assert!(o.flag("unsigned"));
        assert!(Options::parse(&args("--nope 1"), &["file"], &[]).is_err());
        assert!(Options::parse(&args("--file"), &["file"], &[]).is_err());
    }
}
