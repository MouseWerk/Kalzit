//! Prometheus metrics: `GET /metrics` in the text exposition format (docs/guide/monitoring.md).
//!
//! Off unless `metrics.enabled`, and then only for a scraper with the token or from an allowed
//! network (`config::MetricsConfig`); the configuration check refuses it open to everyone. Labels
//! carry only fixed words and data source kinds: never user names, addresses, query text, ids or
//! secrets.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::sync::Mutex;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::app::AppState;
use crate::locks::MutexExt;
use crate::net::RequestInfo;

/// Seconds; the upper bounds of the request histogram.
const REQUEST_BUCKETS: &[f64] = &[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0];
/// Seconds; the upper bounds of the query histograms (queries may run for minutes).
const QUERY_BUCKETS: &[f64] = &[0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0, 300.0];

/// How a query ended, for `kalzit_query_duration_seconds{outcome}`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum QueryOutcome {
    Ok,
    Error,
    Timeout,
}

impl QueryOutcome {
    fn label(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Error => "error",
            Self::Timeout => "timeout",
        }
    }
}

struct Histogram {
    bounds: &'static [f64],
    /// Per bucket, not cumulative; one more for `+Inf`.
    counts: Vec<AtomicU64>,
    sum_nanos: AtomicU64,
}

impl Histogram {
    fn new(bounds: &'static [f64]) -> Self {
        Self { bounds, counts: (0..=bounds.len()).map(|_| AtomicU64::new(0)).collect(), sum_nanos: AtomicU64::new(0) }
    }

    fn observe(&self, took: Duration) {
        let secs = took.as_secs_f64();
        let bucket = self.bounds.iter().position(|b| secs <= *b).unwrap_or(self.bounds.len());
        self.counts[bucket].fetch_add(1, Ordering::Relaxed);
        self.sum_nanos.fetch_add(u64::try_from(took.as_nanos()).unwrap_or(u64::MAX), Ordering::Relaxed);
    }

    fn write(&self, out: &mut String, name: &str, labels: &str) {
        let sep = if labels.is_empty() { "" } else { "," };
        let mut total = 0;
        for (i, bound) in self.bounds.iter().enumerate() {
            total += self.counts[i].load(Ordering::Relaxed);
            let _ = writeln!(out, "{name}_bucket{{{labels}{sep}le=\"{bound}\"}} {total}");
        }
        total += self.counts[self.bounds.len()].load(Ordering::Relaxed);
        let _ = writeln!(out, "{name}_bucket{{{labels}{sep}le=\"+Inf\"}} {total}");
        let sum = self.sum_nanos.load(Ordering::Relaxed) as f64 / 1e9;
        let braces = if labels.is_empty() { String::new() } else { format!("{{{labels}}}") };
        let _ = writeln!(out, "{name}_sum{braces} {sum}");
        let _ = writeln!(out, "{name}_count{braces} {total}");
    }
}

/// What the server counts while it runs; read by `serve`.
pub struct Metrics {
    started_unix_secs: f64,
    /// Answers by status class, 1xx to 5xx.
    requests: [AtomicU64; 5],
    in_flight: AtomicI64,
    request_seconds: Histogram,
    /// By data source kind and outcome.
    queries: Mutex<BTreeMap<(String, QueryOutcome), Histogram>>,
    /// Alert rule evaluations: those that ended in the error state, and the others.
    alert_evaluations: [AtomicU64; 2],
    /// Scheduled evaluations skipped because the rule could not start before its next slot.
    alert_skipped: AtomicU64,
    /// Attempts to deliver an alert notification: failed, and arrived.
    alert_deliveries: [AtomicU64; 2],
}

impl Default for Metrics {
    fn default() -> Self {
        Self {
            started_unix_secs: SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64()),
            requests: Default::default(),
            in_flight: AtomicI64::new(0),
            request_seconds: Histogram::new(REQUEST_BUCKETS),
            queries: Mutex::default(),
            alert_evaluations: Default::default(),
            alert_skipped: AtomicU64::new(0),
            alert_deliveries: Default::default(),
        }
    }
}

impl Metrics {
    pub fn request(&self, status: StatusCode, took: Duration) {
        let class = usize::from(status.as_u16() / 100).clamp(1, 5) - 1;
        self.requests[class].fetch_add(1, Ordering::Relaxed);
        self.request_seconds.observe(took);
    }

    /// One query against a data source of `kind` (a built-in kind or a plugin's), as it ended.
    pub fn query(&self, kind: &str, outcome: QueryOutcome, took: Duration) {
        let mut queries = self.queries.lock_or_recover();
        queries.entry((kind.to_string(), outcome)).or_insert_with(|| Histogram::new(QUERY_BUCKETS)).observe(took);
    }

    /// One scheduled evaluation of an alert rule, ending in the error state or not.
    pub fn alert_evaluation(&self, error: bool) {
        self.alert_evaluations[usize::from(error)].fetch_add(1, Ordering::Relaxed);
    }

    /// Scheduled evaluations that were skipped, not caught up.
    pub fn alert_skipped(&self, n: u64) {
        self.alert_skipped.fetch_add(n, Ordering::Relaxed);
    }

    /// One attempt to deliver an alert notification.
    pub fn alert_delivery(&self, ok: bool) {
        self.alert_deliveries[usize::from(ok)].fetch_add(1, Ordering::Relaxed);
    }

    fn write(&self, out: &mut String) {
        help(out, "kalzit_http_requests_total", "counter", "HTTP requests answered, by status class.");
        for (i, count) in self.requests.iter().enumerate() {
            let _ =
                writeln!(out, "kalzit_http_requests_total{{code=\"{}xx\"}} {}", i + 1, count.load(Ordering::Relaxed));
        }
        help(out, "kalzit_http_requests_in_flight", "gauge", "HTTP requests being answered now.");
        let _ = writeln!(out, "kalzit_http_requests_in_flight {}", self.in_flight.load(Ordering::Relaxed));
        help(out, "kalzit_http_request_duration_seconds", "histogram", "Time to answer an HTTP request.");
        self.request_seconds.write(out, "kalzit_http_request_duration_seconds", "");
        help(
            out,
            "kalzit_query_duration_seconds",
            "histogram",
            "Time of data source queries, by data source kind and outcome (cache hits not included).",
        );
        let queries = self.queries.lock_or_recover();
        for ((kind, outcome), histogram) in queries.iter() {
            let labels = format!("kind=\"{}\",outcome=\"{}\"", escape(kind), outcome.label());
            histogram.write(out, "kalzit_query_duration_seconds", &labels);
        }
        drop(queries);
        help(out, "kalzit_alert_evaluations_total", "counter", "Scheduled alert rule evaluations, by outcome.");
        for (i, outcome) in ["ok", "error"].iter().enumerate() {
            let n = self.alert_evaluations[i].load(Ordering::Relaxed);
            let _ = writeln!(out, "kalzit_alert_evaluations_total{{outcome=\"{outcome}\"}} {n}");
        }
        help(
            out,
            "kalzit_alert_evaluations_skipped_total",
            "counter",
            "Scheduled alert rule evaluations skipped because the rule could not start before its next slot.",
        );
        let _ = writeln!(out, "kalzit_alert_evaluations_skipped_total {}", self.alert_skipped.load(Ordering::Relaxed));
        help(out, "kalzit_alert_deliveries_total", "counter", "Attempts to deliver alert notifications, by result.");
        for (i, result) in ["failed", "ok"].iter().enumerate() {
            let n = self.alert_deliveries[i].load(Ordering::Relaxed);
            let _ = writeln!(out, "kalzit_alert_deliveries_total{{result=\"{result}\"}} {n}");
        }
    }
}

/// Counts every request: in flight while it runs, then its status class and time.
pub async fn track(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let metrics = &state.metrics;
    metrics.in_flight.fetch_add(1, Ordering::Relaxed);
    let started = Instant::now();
    let res = next.run(req).await;
    metrics.in_flight.fetch_sub(1, Ordering::Relaxed);
    metrics.request(res.status(), started.elapsed());
    res
}

/// `GET /metrics`: 404 while metrics are off, 403 outside the allowed networks, 401 without the
/// right token.
pub async fn serve(State(state): State<AppState>, req: Request) -> Response {
    let config = &state.config.metrics;
    if !config.enabled {
        return StatusCode::NOT_FOUND.into_response();
    }
    if !config.allowed_networks.is_empty() {
        let client = req.extensions().get::<RequestInfo>().map(|i| i.client_ip.to_canonical());
        if !client.is_some_and(|ip| config.allowed_networks.iter().any(|n| n.contains(&ip))) {
            return StatusCode::FORBIDDEN.into_response();
        }
    }
    if !config.token.is_empty() && !token_matches(req.headers(), config.token.trim()) {
        let mut res = StatusCode::UNAUTHORIZED.into_response();
        res.headers_mut().insert(header::WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
        return res;
    }
    let body = render(&state).await;
    let mut res = body.into_response();
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain; version=0.0.4; charset=utf-8"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

/// `Authorization: Bearer <token>`, compared in constant time (as hashes, so the length does not
/// show either).
fn token_matches(headers: &HeaderMap, token: &str) -> bool {
    let Some(sent) = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split_once(' '))
        .filter(|(scheme, _)| scheme.eq_ignore_ascii_case("bearer"))
        .map(|(_, value)| value.trim())
    else {
        return false;
    };
    Sha256::digest(sent.as_bytes()).ct_eq(&Sha256::digest(token.as_bytes())).into()
}

async fn render(state: &AppState) -> String {
    let mut out = String::new();
    help(&mut out, "kalzit_build_info", "gauge", "The running version of Kalzit.");
    let _ = writeln!(out, "kalzit_build_info{{version=\"{}\"}} 1", escape(env!("CARGO_PKG_VERSION")));
    help(&mut out, "process_start_time_seconds", "gauge", "Start time of the process since the Unix epoch.");
    let _ = writeln!(out, "process_start_time_seconds {}", state.metrics.started_unix_secs);
    if let Some(process) = process::read() {
        help(&mut out, "process_cpu_seconds_total", "counter", "CPU time the process used, user and system.");
        let _ = writeln!(out, "process_cpu_seconds_total {}", process.cpu_secs);
        help(&mut out, "process_resident_memory_bytes", "gauge", "Memory of the process held in RAM.");
        let _ = writeln!(out, "process_resident_memory_bytes {}", process.resident_bytes);
    }
    state.metrics.write(&mut out);

    let cache = state.datasources.query_cache().stats();
    help(&mut out, "kalzit_query_cache_hits_total", "counter", "Queries answered from the query cache.");
    let _ = writeln!(out, "kalzit_query_cache_hits_total {}", cache.hits);
    help(&mut out, "kalzit_query_cache_misses_total", "counter", "Queries the query cache could not answer.");
    let _ = writeln!(out, "kalzit_query_cache_misses_total {}", cache.misses);
    help(&mut out, "kalzit_query_cache_entries", "gauge", "Answers in the query cache.");
    let _ = writeln!(out, "kalzit_query_cache_entries {}", cache.entries);
    help(&mut out, "kalzit_query_cache_bytes", "gauge", "Size of the answers in the query cache.");
    let _ = writeln!(out, "kalzit_query_cache_bytes {}", cache.bytes);

    let now = state.clock.now_ms();
    let sessions: Result<i64, _> =
        sqlx::query_scalar("SELECT COUNT(*) FROM sessions WHERE expires_at > $1 AND last_seen_at > $2")
            .bind(now)
            .bind(crate::auth::session::idle_cutoff(&state.config.sessions, now))
            .fetch_one(&state.read_db)
            .await;
    match sessions {
        Ok(count) => {
            help(&mut out, "kalzit_sessions_active", "gauge", "Sign-in sessions that have not ended.");
            let _ = writeln!(out, "kalzit_sessions_active {count}");
        }
        Err(e) => tracing::warn!("metrics: counting the sessions failed: {e}"),
    }

    help(&mut out, "kalzit_plugin_processes", "gauge", "Plugin processes, by state.");
    let mut states = state.plugins.process_states();
    states.entry("running").or_insert(0);
    for (name, count) in states {
        let _ = writeln!(out, "kalzit_plugin_processes{{state=\"{name}\"}} {count}");
    }
    out
}

fn help(out: &mut String, name: &str, kind: &str, text: &str) {
    let _ = writeln!(out, "# HELP {name} {text}");
    let _ = writeln!(out, "# TYPE {name} {kind}");
}

/// A label value as the text format wants it.
fn escape(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n")
}

mod process {
    pub struct Process {
        pub cpu_secs: f64,
        pub resident_bytes: u64,
    }

    #[cfg(target_os = "linux")]
    pub fn read() -> Option<Process> {
        // Fields after the command name, which is in parentheses and may contain spaces.
        let stat = std::fs::read_to_string("/proc/self/stat").ok()?;
        let fields: Vec<&str> = stat.rsplit_once(')')?.1.split_whitespace().collect();
        // utime and stime are fields 14 and 15 of the whole line, 12 and 13 after the name.
        let ticks: u64 = fields.get(11)?.parse::<u64>().ok()? + fields.get(12)?.parse::<u64>().ok()?;
        // SAFETY: sysconf only reads a system constant.
        let (hz, page) = unsafe { (libc::sysconf(libc::_SC_CLK_TCK), libc::sysconf(libc::_SC_PAGESIZE)) };
        let statm = std::fs::read_to_string("/proc/self/statm").ok()?;
        let pages: u64 = statm.split_whitespace().nth(1)?.parse().ok()?;
        (hz > 0 && page > 0)
            .then(|| Process { cpu_secs: ticks as f64 / hz as f64, resident_bytes: pages * page as u64 })
    }

    #[cfg(windows)]
    pub fn read() -> Option<Process> {
        use windows::Win32::Foundation::FILETIME;
        use windows::Win32::System::ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
        use windows::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};
        let (mut created, mut exited, mut kernel, mut user) =
            (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
        let mut memory = PROCESS_MEMORY_COUNTERS::default();
        // SAFETY: the pseudo handle of this process needs no closing; the out-parameters live on
        // this stack frame and the size passed is the size of the structure.
        unsafe {
            let process = GetCurrentProcess();
            GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user).ok()?;
            let size = u32::try_from(std::mem::size_of::<PROCESS_MEMORY_COUNTERS>()).ok()?;
            K32GetProcessMemoryInfo(process, &mut memory, size).ok().ok()?;
        }
        // 100-nanosecond intervals.
        let hundreds = |t: FILETIME| (u64::from(t.dwHighDateTime) << 32) | u64::from(t.dwLowDateTime);
        Some(Process {
            cpu_secs: (hundreds(kernel) + hundreds(user)) as f64 / 1e7,
            resident_bytes: memory.WorkingSetSize as u64,
        })
    }

    #[cfg(not(any(target_os = "linux", windows)))]
    pub fn read() -> Option<Process> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn histograms_are_cumulative_with_sum_and_count() {
        let m = Metrics::default();
        m.query("postgres", QueryOutcome::Ok, Duration::from_millis(20));
        m.query("postgres", QueryOutcome::Ok, Duration::from_secs(2));
        m.query("neo4j", QueryOutcome::Timeout, Duration::from_secs(400));
        m.request(StatusCode::OK, Duration::from_millis(3));
        m.request(StatusCode::NOT_FOUND, Duration::from_millis(3));
        let mut out = String::new();
        m.write(&mut out);
        assert!(out.contains("kalzit_query_duration_seconds_bucket{kind=\"postgres\",outcome=\"ok\",le=\"0.01\"} 0\n"));
        assert!(out.contains("kalzit_query_duration_seconds_bucket{kind=\"postgres\",outcome=\"ok\",le=\"0.05\"} 1\n"));
        assert!(out.contains("kalzit_query_duration_seconds_bucket{kind=\"postgres\",outcome=\"ok\",le=\"+Inf\"} 2\n"));
        assert!(out.contains("kalzit_query_duration_seconds_count{kind=\"postgres\",outcome=\"ok\"} 2\n"));
        assert!(
            out.contains("kalzit_query_duration_seconds_bucket{kind=\"neo4j\",outcome=\"timeout\",le=\"300\"} 0\n")
        );
        assert!(out.contains("kalzit_http_requests_total{code=\"2xx\"} 1\n"));
        assert!(out.contains("kalzit_http_requests_total{code=\"4xx\"} 1\n"));
        assert!(out.contains("kalzit_http_request_duration_seconds_count 2\n"));
    }

    #[test]
    fn label_values_are_escaped() {
        assert_eq!(escape("a\"b\\c\nd"), "a\\\"b\\\\c\\nd");
    }

    #[test]
    fn only_the_right_bearer_token_matches() {
        let with = |value: &'static str| {
            let mut h = HeaderMap::new();
            h.insert(header::AUTHORIZATION, HeaderValue::from_static(value));
            h
        };
        assert!(token_matches(&with("Bearer 0123456789abcdef"), "0123456789abcdef"));
        assert!(token_matches(&with("bearer 0123456789abcdef"), "0123456789abcdef"));
        assert!(!token_matches(&with("Bearer 0123456789abcdeX"), "0123456789abcdef"));
        assert!(!token_matches(&with("Basic 0123456789abcdef"), "0123456789abcdef"));
        assert!(!token_matches(&HeaderMap::new(), "0123456789abcdef"));
    }

    #[test]
    fn this_process_is_measured() {
        if cfg!(any(target_os = "linux", windows)) {
            let p = process::read().expect("process figures");
            assert!(p.resident_bytes > 0 && p.cpu_secs >= 0.0);
        }
    }
}
