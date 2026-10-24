//! `kalzit-sign`, the release signing tool (docs/operations/updates.md, "Release key").
//!
//! ```text
//! kalzit-sign keygen --out <file>
//! kalzit-sign release --version <v> [--channel stable|preview] [--notes <file>] [--notes-url <https url>]
//!                     [--minimum-version <v>] --package <platform>:<arch>:<path>... [--out-dir <dir>]
//! kalzit-sign verify --public-key <base64> --manifest <file> --signature <file> [--package <path>]...
//! ```
//!
//! `keygen` writes the private key into a new file readable only by its owner and prints the
//! public key; the private key is never printed. `release` signs with the key in the environment
//! variable `KALZIT_RELEASE_SIGNING_KEY` and writes the manifest, its signature and one offline
//! package per binary. `verify` checks a release the way a server does.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use kalzit_release::{
    BUNDLE_EXTENSION, Channel, DetachedSignature, Manifest, highlights_from_notes, key_id, manifest_message,
    package_message, parse_public_key, public_key_base64, sha256_hex, sign_manifest, sign_package, signature_matches,
    signing_key_from_base64, write_bundle,
};
use zeroize::Zeroizing;

const KEY_ENV: &str = "KALZIT_RELEASE_SIGNING_KEY";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(text) => {
            println!("{text}");
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("kalzit-sign: {e}");
            ExitCode::FAILURE
        }
    }
}

/// `--name value` options; repeated names keep every value.
struct Options(Vec<(String, String)>);

impl Options {
    fn parse(args: &[String], known: &[&str]) -> Result<Self, String> {
        let mut out = Vec::new();
        let mut rest = args.iter();
        while let Some(arg) = rest.next() {
            let name = arg.strip_prefix("--").ok_or_else(|| format!("unexpected argument {arg}"))?;
            if !known.contains(&name) {
                return Err(format!("unknown option --{name}"));
            }
            let value = rest.next().ok_or_else(|| format!("--{name} needs a value"))?;
            out.push((name.to_string(), value.clone()));
        }
        Ok(Self(out))
    }

    fn one(&self, name: &str) -> Option<&str> {
        self.0.iter().rev().find(|(n, _)| n == name).map(|(_, v)| v.as_str())
    }

    fn required(&self, name: &str) -> Result<&str, String> {
        self.one(name).ok_or_else(|| format!("--{name} is required"))
    }

    fn all(&self, name: &str) -> Vec<&str> {
        self.0.iter().filter(|(n, _)| n == name).map(|(_, v)| v.as_str()).collect()
    }
}

fn run(args: &[String]) -> Result<String, String> {
    let (command, rest) = args.split_first().ok_or("usage: kalzit-sign keygen|release|verify ...")?;
    match command.as_str() {
        "keygen" => {
            let o = Options::parse(rest, &["out"])?;
            keygen(Path::new(o.required("out")?))
        }
        "release" => {
            let o = Options::parse(
                rest,
                &["version", "channel", "notes", "notes-url", "minimum-version", "package", "out-dir"],
            )?;
            release(&o)
        }
        "verify" => {
            let o = Options::parse(rest, &["public-key", "manifest", "signature", "package"])?;
            verify(&o)
        }
        other => Err(format!("unknown command {other}; use keygen, release or verify")),
    }
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
    restrict_to_owner(out)?;
    std::io::Write::write_all(&mut file, encoded.as_bytes()).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    Ok(format!(
        "private key written to {} (store it as the repository secret {KEY_ENV}, keep an offline copy, then \
         delete the file)\npublic key: {}\nkey id: {}",
        out.display(),
        public_key_base64(&key),
        key_id(&key.verifying_key())
    ))
}

/// Windows: the new key file keeps only an entry for the current user (no inherited ones).
#[cfg(windows)]
fn restrict_to_owner(path: &Path) -> Result<(), String> {
    let user = std::env::var("USERNAME").map_err(|_| "USERNAME is not set".to_string())?;
    let status = std::process::Command::new("icacls")
        .arg(path)
        .args(["/inheritance:r", "/grant:r"])
        .arg(format!("{user}:F"))
        .stdout(std::process::Stdio::null())
        .status()
        .map_err(|e| format!("running icacls: {e}"))?;
    if status.success() { Ok(()) } else { Err(format!("icacls could not restrict {}", path.display())) }
}

#[cfg(not(windows))]
fn restrict_to_owner(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn release(o: &Options) -> Result<String, String> {
    let secret = Zeroizing::new(std::env::var(KEY_ENV).map_err(|_| format!("{KEY_ENV} is not set"))?);
    let key = signing_key_from_base64(&secret)?;
    let version = o.required("version")?.to_string();
    let channel = match o.one("channel").unwrap_or("stable") {
        "stable" => Channel::Stable,
        "preview" => Channel::Preview,
        other => return Err(format!("unknown channel {other}")),
    };
    let notes_text = match o.one("notes") {
        Some(path) => std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?,
        None => String::new(),
    };
    let notes_url = o.one("notes-url").map(str::to_string);
    if notes_url.as_deref().is_some_and(|u| !u.starts_with("https://")) {
        return Err("--notes-url must be an https URL".into());
    }
    let mut packages = Vec::new();
    let mut files: Vec<(PathBuf, Vec<u8>)> = Vec::new();
    for spec in o.all("package") {
        let mut parts = spec.splitn(3, ':');
        let (Some(platform), Some(arch), Some(path)) = (parts.next(), parts.next(), parts.next()) else {
            return Err(format!("{spec}: expected platform:arch:path"));
        };
        let path = PathBuf::from(path);
        let data = std::fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        let file = path.file_name().ok_or("a package path has no file name")?.to_string_lossy().into_owned();
        packages.push(sign_package(&key, &version, platform, arch, &file, &data));
        files.push((path, data));
    }
    if packages.is_empty() {
        return Err("at least one --package is required".into());
    }
    let manifest = Manifest {
        format: 1,
        product: "kalzit".into(),
        version: version.clone(),
        channel,
        released_at: Some(now_rfc3339()),
        minimum_version: o.one("minimum-version").map(str::to_string),
        notes: summary(&notes_text),
        notes_url,
        highlights: highlights_from_notes(&notes_text),
        packages,
    };
    let bytes = serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?;
    let signature = serde_json::to_vec(&sign_manifest(&key, &bytes)).map_err(|e| e.to_string())?;
    // The tool checks its own output the way a server will.
    check(&public_key_base64(&key), &bytes, &signature, &files)?;
    let out_dir = PathBuf::from(o.one("out-dir").unwrap_or("."));
    std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
    let name = format!("kalzit-{version}-manifest.json");
    std::fs::write(out_dir.join(&name), &bytes).map_err(|e| e.to_string())?;
    std::fs::write(out_dir.join(format!("{name}.sig")), &signature).map_err(|e| e.to_string())?;
    let mut bundles = Vec::new();
    for (path, data) in &files {
        let stem = path.file_name().unwrap_or_default().to_string_lossy();
        let stem = stem.strip_suffix(".exe").unwrap_or(&stem);
        let bundle = format!("{stem}.{BUNDLE_EXTENSION}");
        let mut out = std::fs::File::create(out_dir.join(&bundle)).map_err(|e| e.to_string())?;
        write_bundle(&mut out, &bytes, &signature, data).map_err(|e| e.to_string())?;
        bundles.push(bundle);
    }
    Ok(format!("wrote {name}, {name}.sig and {}, signed with key {}", bundles.join(", "), key_id(&key.verifying_key())))
}

/// Verifies a manifest, every package entry and the given package files against `public_key`.
fn check(public_key: &str, manifest: &[u8], signature: &[u8], files: &[(PathBuf, Vec<u8>)]) -> Result<String, String> {
    let key = parse_public_key(public_key)?;
    let sig: DetachedSignature = serde_json::from_slice(signature).map_err(|e| format!("the signature file: {e}"))?;
    if sig.key_id != key_id(&key) {
        return Err(format!("the release is signed with key {}, not with key {}", sig.key_id, key_id(&key)));
    }
    if !signature_matches(&key, &manifest_message(manifest), &sig) {
        return Err("the manifest signature does not match".into());
    }
    let m: Manifest = serde_json::from_slice(manifest).map_err(|e| format!("the manifest: {e}"))?;
    for p in &m.packages {
        let message = package_message(&m.version, &p.platform, &p.arch, &p.file, p.size, &p.sha256);
        if p.signature.key_id != key_id(&key) || !signature_matches(&key, &message, &p.signature) {
            return Err(format!("the signature of {} does not match", p.file));
        }
    }
    for (path, data) in files {
        let sha = sha256_hex(data);
        if !m.packages.iter().any(|p| p.sha256 == sha && p.size == data.len() as u64) {
            return Err(format!("{} does not match the manifest", path.display()));
        }
    }
    Ok(format!("{} verified ({} packages listed, {} checked)", m.version, m.packages.len(), files.len()))
}

fn verify(o: &Options) -> Result<String, String> {
    let manifest = std::fs::read(o.required("manifest")?).map_err(|e| e.to_string())?;
    let signature = std::fs::read(o.required("signature")?).map_err(|e| e.to_string())?;
    let mut files = Vec::new();
    for path in o.all("package") {
        let data = std::fs::read(path).map_err(|e| format!("{path}: {e}"))?;
        files.push((PathBuf::from(path), data));
    }
    check(o.required("public-key")?, &manifest, &signature, &files)
}

/// The first paragraph of the notes after the title, as the plain summary.
fn summary(notes: &str) -> String {
    notes
        .lines()
        .skip_while(|l| l.trim().is_empty() || l.starts_with('#'))
        .take_while(|l| !l.trim().is_empty() && !l.starts_with('#'))
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(2000)
        .collect()
}

/// The current UTC time in RFC 3339 (civil date from days since 1970, no time zone database).
fn now_rfc3339() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let (days, rest) = (secs / 86_400, secs % 86_400);
    // Howard Hinnant's days_from_civil, inverted.
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z", rest / 3600, rest % 3600 / 60, rest % 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(text: &str) -> Vec<String> {
        text.split_whitespace().map(str::to_string).collect()
    }

    #[test]
    fn options_are_parsed_and_checked() {
        let o = Options::parse(&args("--package a --package b --version 1.0.0"), &["package", "version"]).unwrap();
        assert_eq!(o.all("package"), ["a", "b"]);
        assert_eq!(o.required("version").unwrap(), "1.0.0");
        assert!(Options::parse(&args("--nope 1"), &["package"]).is_err());
        assert!(Options::parse(&args("--package"), &["package"]).is_err());
    }

    #[test]
    fn a_signed_release_checks_and_a_changed_file_does_not() {
        let key = ed25519_dalek::SigningKey::from_bytes(&[3; 32]);
        let package = sign_package(&key, "1.0.0", "linux", "x64", "kalzit-1.0.0-linux-x64", b"binary");
        let manifest = Manifest {
            format: 1,
            product: "kalzit".into(),
            version: "1.0.0".into(),
            channel: Channel::Stable,
            released_at: None,
            minimum_version: None,
            notes: String::new(),
            notes_url: None,
            highlights: vec![],
            packages: vec![package],
        };
        let bytes = serde_json::to_vec(&manifest).unwrap();
        let sig = serde_json::to_vec(&sign_manifest(&key, &bytes)).unwrap();
        let public = public_key_base64(&key);
        let ok = vec![(PathBuf::from("p"), b"binary".to_vec())];
        assert!(check(&public, &bytes, &sig, &ok).is_ok());
        let changed = vec![(PathBuf::from("p"), b"binarY".to_vec())];
        assert!(check(&public, &bytes, &sig, &changed).is_err());
        let other = public_key_base64(&ed25519_dalek::SigningKey::from_bytes(&[4; 32]));
        assert!(check(&other, &bytes, &sig, &ok).is_err());
    }

    #[test]
    fn dates_are_rfc3339() {
        let text = now_rfc3339();
        assert_eq!(text.len(), 20);
        assert!(text.starts_with("20") && text.ends_with('Z'), "{text}");
    }
}
