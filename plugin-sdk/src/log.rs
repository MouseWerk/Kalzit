//! Logging for plugins: one line per message on stderr, which Kalzit keeps per plugin (the
//! plugin's logs in the administration) and writes into its own log with the plugin id. Stdout
//! carries only the handshake; do not print there.
//!
//! Kalzit keeps the last 2000 lines, cuts lines at 4 KiB and drops more than 200 lines per
//! second, so log what helps an administrator, not every row. Never log secrets.

use std::io::Write;

fn line(level: &str, message: &str) {
    // One write per line, so lines of several threads do not interleave; newlines inside the
    // message would start lines the host cannot attribute, so they become spaces.
    let text = format!("{level} {}\n", message.replace(['\r', '\n'], " "));
    let _ = std::io::stderr().lock().write_all(text.as_bytes());
}

pub fn error(message: &str) {
    line("ERROR", message);
}

pub fn warn(message: &str) {
    line("WARN", message);
}

pub fn info(message: &str) {
    line("INFO", message);
}

/// Written only when the environment variable `KALZIT_PLUGIN_DEBUG` is set (in development; the
/// host does not pass it).
pub fn debug(message: &str) {
    if std::env::var_os("KALZIT_PLUGIN_DEBUG").is_some() {
        line("DEBUG", message);
    }
}

/// `info!("{} rows", n)`: [`info`] with formatting. `error!`, `warn!` and `debug!` likewise.
#[macro_export]
macro_rules! info {
    ($($arg:tt)*) => { $crate::log::info(&format!($($arg)*)) };
}

#[macro_export]
macro_rules! warn {
    ($($arg:tt)*) => { $crate::log::warn(&format!($($arg)*)) };
}

#[macro_export]
macro_rules! error {
    ($($arg:tt)*) => { $crate::log::error(&format!($($arg)*)) };
}

#[macro_export]
macro_rules! debug {
    ($($arg:tt)*) => { $crate::log::debug(&format!($($arg)*)) };
}
