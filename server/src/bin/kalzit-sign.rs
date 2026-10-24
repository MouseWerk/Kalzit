//! The release signing tool (docs/operations/updates.md, "Release key").
//!
//! - `kalzit-sign keygen --out <file>` makes a new key pair: the private key goes into the file
//!   (created new, readable by its owner only), the public key and its id are printed. The
//!   private key is never printed.
//! - `kalzit-sign release ...` writes the signed manifest of a release and its detached
//!   signature, with the key from the environment variable `KALZIT_RELEASE_SIGNING_KEY`.
//! - `kalzit-sign verify ...` checks a manifest, its signature and packages against a public key,
//!   as a server would.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use clap::{Parser, Subcommand};
use kalzit::updates::signing::{self, Channel, Manifest, TrustedKeys};
use kalzit::updates::staging;
use zeroize::Zeroizing;

const KEY_ENV: &str = "KALZIT_RELEASE_SIGNING_KEY";

#[derive(Parser)]
#[command(name = "kalzit-sign", version, about = "Signs Kalzit releases")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Make a new Ed25519 key pair; the private key goes into a new file.
    Keygen {
        /// Where the private key is written (must not exist yet).
        #[arg(long)]
        out: PathBuf,
    },
    /// Write `kalzit-<version>-manifest.json` and its `.sig` for the given packages, signed with
    /// the key in KALZIT_RELEASE_SIGNING_KEY.
    Release {
        #[arg(long)]
        version: String,
        #[arg(long, default_value = "stable")]
        channel: String,
        /// Release notes in the format of docs/releases/v<version>.md.
        #[arg(long)]
        notes: Option<PathBuf>,
        #[arg(long)]
        notes_url: Option<String>,
        #[arg(long)]
        minimum_version: Option<String>,
        /// `platform:arch:path`, for example `linux:x64:dist/kalzit-0.2.0-linux-x64`. The file
        /// name becomes the asset name.
        #[arg(long = "package", required = true)]
        packages: Vec<String>,
        #[arg(long, default_value = ".")]
        out_dir: PathBuf,
    },
    /// Verify a manifest, its signature and optionally package files with a public key.
    Verify {
        #[arg(long)]
        public_key: String,
        #[arg(long)]
        manifest: PathBuf,
        #[arg(long)]
        signature: PathBuf,
        #[arg(long = "package")]
        packages: Vec<PathBuf>,
    },
}

fn main() -> ExitCode {
    match run(Cli::parse().command) {
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

fn run(command: Command) -> Result<String, String> {
    match command {
        Command::Keygen { out } => keygen(&out),
        Command::Release { version, channel, notes, notes_url, minimum_version, packages, out_dir } => {
            let key = std::env::var(KEY_ENV).map_err(|_| format!("{KEY_ENV} is not set"))?;
            let key = Zeroizing::new(key);
            let key = signing::signing_key_from_base64(&key)?;
            let channel = match channel.as_str() {
                "stable" => Channel::Stable,
                "preview" => Channel::Preview,
                other => return Err(format!("unknown channel {other}")),
            };
            let notes_text = match &notes {
                Some(path) => std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?,
                None => String::new(),
            };
            let mut signed = Vec::new();
            for spec in &packages {
                let mut parts = spec.splitn(3, ':');
                let (Some(platform), Some(arch), Some(path)) = (parts.next(), parts.next(), parts.next()) else {
                    return Err(format!("{spec}: expected platform:arch:path"));
                };
                let path = Path::new(path);
                let data = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
                let file = path.file_name().ok_or("a package path has no file name")?.to_string_lossy().into_owned();
                signed.push(signing::sign_package(&key, &version, platform, arch, &file, &data));
            }
            let manifest = Manifest {
                format: 1,
                product: "kalzit".into(),
                version: version.clone(),
                channel,
                released_at: Some(chrono_now()),
                minimum_version,
                notes: summary(&notes_text),
                notes_url,
                highlights: signing::highlights_from_notes(&notes_text),
                packages: signed,
            };
            let bytes = serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?;
            let signature = serde_json::to_vec(&signing::sign_manifest(&key, &bytes)).map_err(|e| e.to_string())?;
            // The tool checks its own output the way a server will.
            let keys = TrustedKeys::from_base64(&[&signing::public_key_base64(&key)])?;
            signing::verify_manifest(&keys, &bytes, &signature).map_err(|e| e.to_string())?;
            std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
            let name = format!("kalzit-{version}-manifest.json");
            std::fs::write(out_dir.join(&name), &bytes).map_err(|e| e.to_string())?;
            std::fs::write(out_dir.join(format!("{name}.sig")), &signature).map_err(|e| e.to_string())?;
            // One offline package per binary: manifest, signature and binary in one file.
            let mut bundles = Vec::new();
            for spec in &packages {
                let path = Path::new(spec.splitn(3, ':').nth(2).unwrap_or_default());
                let data = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
                let stem = path.file_name().unwrap_or_default().to_string_lossy();
                let stem = stem.strip_suffix(".exe").unwrap_or(&stem);
                let bundle = format!("{stem}.{}", staging::BUNDLE_EXTENSION);
                let mut out = std::fs::File::create(out_dir.join(&bundle)).map_err(|e| e.to_string())?;
                staging::write_bundle(&mut out, &bytes, &signature, &data).map_err(|e| e.to_string())?;
                bundles.push(bundle);
            }
            Ok(format!(
                "wrote {name}, {name}.sig and {}, signed with key {}",
                bundles.join(", "),
                signing::key_id(&key.verifying_key())
            ))
        }
        Command::Verify { public_key, manifest, signature, packages } => {
            let keys = TrustedKeys::from_base64(&[&public_key])?;
            let bytes = std::fs::read(&manifest).map_err(|e| e.to_string())?;
            let sig = std::fs::read(&signature).map_err(|e| e.to_string())?;
            let m = signing::verify_manifest(&keys, &bytes, &sig).map_err(|e| e.to_string())?;
            for path in &packages {
                let (sha256, size) = staging::hash_file(path).map_err(|e| e.to_string())?;
                let ok = m.packages.iter().any(|p| p.sha256 == sha256 && p.size == size);
                if !ok {
                    return Err(format!("{} does not match the manifest", path.display()));
                }
            }
            Ok(format!("{} verified ({} packages listed, {} checked)", m.version, m.packages.len(), packages.len()))
        }
    }
}

fn keygen(out: &Path) -> Result<String, String> {
    let seed = Zeroizing::new(rand::random::<[u8; 32]>());
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
    std::io::Write::write_all(&mut file, encoded.as_bytes()).map_err(|e| e.to_string())?;
    Ok(format!(
        "private key written to {} (keep it secret; store it as the repository secret {KEY_ENV}, then delete the file)\n\
         public key: {}\nkey id: {}",
        out.display(),
        signing::public_key_base64(&key),
        signing::key_id(&key.verifying_key())
    ))
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

/// The current UTC time in RFC 3339, without a time zone database.
fn chrono_now() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    chrono::DateTime::from_timestamp(secs as i64, 0)
        .map(|t| t.format("%Y-%m-%dT%H:%M:%SZ").to_string())
        .unwrap_or_default()
}
