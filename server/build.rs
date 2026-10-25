//! Embeds the commit and the date of the build, shown in Settings, About. `KALZIT_BUILD_COMMIT`
//! and `KALZIT_BUILD_DATE` in the environment win (release pipelines, source archives without a
//! `.git` folder); otherwise git is asked; without either the commit is "unknown" and the date is
//! today's.

use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

fn git(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok()?;
    let text = String::from_utf8(out.stdout).ok()?.trim().to_string();
    (out.status.success() && !text.is_empty()).then_some(text)
}

/// Only what a short commit id and an ISO date can look like, so nothing odd lands in the source.
fn clean(value: String, allowed: fn(char) -> bool) -> Option<String> {
    (value.len() <= 40 && value.chars().all(allowed)).then_some(value)
}

/// The civil date of a Unix time (days since 1970-01-01 to year, month, day).
fn date_of(secs: u64) -> String {
    let z = (secs / 86_400) as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

fn main() {
    println!("cargo:rerun-if-env-changed=KALZIT_BUILD_COMMIT");
    println!("cargo:rerun-if-env-changed=KALZIT_BUILD_DATE");
    println!("cargo:rerun-if-env-changed=SOURCE_DATE_EPOCH");
    if let Some(head) = git(&["rev-parse", "--git-path", "HEAD"]) {
        println!("cargo:rerun-if-changed={head}");
    }

    let commit = std::env::var("KALZIT_BUILD_COMMIT")
        .ok()
        .or_else(|| git(&["rev-parse", "--short=9", "HEAD"]))
        .and_then(|v| clean(v, |c| c.is_ascii_hexdigit()))
        .unwrap_or_else(|| "unknown".into());

    let date = std::env::var("KALZIT_BUILD_DATE")
        .ok()
        .and_then(|v| clean(v, |c| c.is_ascii_digit() || c == '-'))
        .unwrap_or_else(|| {
            let epoch = std::env::var("SOURCE_DATE_EPOCH").ok().and_then(|v| v.parse::<u64>().ok());
            let secs = epoch.unwrap_or_else(|| SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs()));
            date_of(secs)
        });

    println!("cargo:rustc-env=KALZIT_BUILD_COMMIT={commit}");
    println!("cargo:rustc-env=KALZIT_BUILD_DATE={date}");
}
