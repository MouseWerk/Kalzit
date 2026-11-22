//! Where a PostgreSQL connection string points, in every form libpq accepts.
//!
//! sqlx parses only one host per URL and ignores what it does not know, so Kalzit's own database
//! cannot be located with it: a multi-host URL (`postgres://h1:1,h2:2/db`), the `host`, `hostaddr`
//! and `port` query parameters, a key=value string and unix-socket directories are all read here.
//! Everything that could name the database is collected, never a subset: a guard that misses one
//! spelling of the own database is no guard.
//!
//! What the string leaves out comes from the environment, as in libpq and sqlx: `PGHOST` and
//! `PGHOSTADDR` when it names no host, `PGPORT` when it names no port (`Defaults::from_env`).

use std::path::PathBuf;

/// libpq's port when none is given.
pub const DEFAULT_PORT: u16 = 5432;

/// Every place a connection string may connect to.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Location {
    /// Host names and IP literals (`hostaddr` included) with their port, in the order given.
    /// A unix-socket directory, or no host at all, adds `localhost`: that database is on this
    /// machine and may listen on TCP too.
    pub tcp: Vec<(String, u16)>,
    /// Socket files, `<directory>/.s.PGSQL.<port>`.
    pub sockets: Vec<PathBuf>,
    /// The string is not SQLite but could not be read: nothing above is known, so a guard refuses
    /// the default port on every address (`own_database`).
    pub unknown: bool,
}

/// What libpq and sqlx take from the environment when the connection string leaves it out.
#[derive(Clone, Debug, Default)]
pub struct Defaults {
    /// `PGHOST`, then `PGHOSTADDR` (comma-separated lists, as in the string).
    pub hosts: Vec<String>,
    /// `PGPORT`.
    pub ports: Vec<String>,
}

impl Defaults {
    pub fn from_env() -> Self {
        let list = |name: &str| -> Vec<String> {
            std::env::var(name)
                .ok()
                .map(|v| v.split(',').map(str::to_string).filter(|s| !s.trim().is_empty()).collect())
                .unwrap_or_default()
        };
        let mut hosts = list("PGHOST");
        hosts.extend(list("PGHOSTADDR"));
        Self { hosts, ports: list("PGPORT") }
    }
}

/// Whether a database URL is PostgreSQL by its scheme (`postgres:` or `postgresql:`, any case).
pub fn is_postgres_url(url: &str) -> bool {
    let url = url.trim();
    ["postgres:", "postgresql:"].iter().any(|p| url.get(..p.len()).is_some_and(|s| s.eq_ignore_ascii_case(p)))
}

/// Where Kalzit's own database is, for the guards that keep plugins, mail and the proxy away
/// from it: `None` when it is SQLite (a file, guarded by path elsewhere). Anything else is
/// PostgreSQL, the only other backend; a string that cannot be read yields `unknown`, never an
/// empty list, so the guards fail closed. Environment defaults apply as for the connection.
pub fn own_database(url: &str) -> Option<Location> {
    let trimmed = url.trim();
    if trimmed.get(..7).is_some_and(|s| s.eq_ignore_ascii_case("sqlite:")) {
        return None;
    }
    Some(
        Location::parse_with(trimmed, &Defaults::from_env())
            .unwrap_or(Location { unknown: true, ..Location::default() }),
    )
}

type Parts = (Vec<String>, Vec<String>, Vec<String>);

impl Location {
    /// Reads a `postgres://` or `postgresql://` URL or a key=value connection string; `None`
    /// when it is neither (SQLite, say) or malformed.
    pub fn parse(input: &str) -> Option<Self> {
        Self::parse_with(input, &Defaults::default())
    }

    /// `parse`, with `defaults` for a missing host or port.
    pub fn parse_with(input: &str, defaults: &Defaults) -> Option<Self> {
        let input = input.trim();
        let rest = ["postgresql://", "postgres://"]
            .iter()
            .find_map(|p| input.get(..p.len()).filter(|s| s.eq_ignore_ascii_case(p)).map(|_| &input[p.len()..]));
        let (hosts, hostaddrs, ports) = match rest {
            Some(rest) => url_parts(rest),
            None if is_conninfo(input) => conninfo_parts(input)?,
            None => return None,
        };
        let (hosts, ports) = fold_defaults(hosts, &hostaddrs, ports, defaults);
        Some(Self::build(hosts, hostaddrs, ports))
    }

    fn build(hosts: Vec<String>, hostaddrs: Vec<String>, ports: Vec<String>) -> Self {
        let ports: Vec<u16> = ports.iter().map(|p| p.trim().parse().unwrap_or(DEFAULT_PORT)).collect();
        // One port serves every host; as many ports as hosts pair up by position. When the lists
        // disagree every combination is protected (never fewer than libpq might use).
        let port_for = |i: usize, len: usize| -> Vec<u16> {
            match ports.len() {
                0 => vec![DEFAULT_PORT],
                1 => ports.clone(),
                n if n == len => vec![ports[i]],
                _ => ports.clone(),
            }
        };
        let mut out = Self::default();
        let add = |name: &str, port: u16, out: &mut Self| {
            if name.is_empty() || name.starts_with('/') || name.starts_with('@') {
                let dir = if name.is_empty() { "/var/run/postgresql" } else { name.trim_start_matches('@') };
                out.sockets.push(PathBuf::from(dir).join(format!(".s.PGSQL.{port}")));
                push_unique(&mut out.tcp, ("localhost".into(), port));
            } else {
                push_unique(&mut out.tcp, (name.trim_matches(['[', ']']).to_string(), port));
            }
        };
        let hosts = if hosts.is_empty() && hostaddrs.is_empty() { vec![String::new()] } else { hosts };
        for (i, h) in hosts.iter().enumerate() {
            for p in port_for(i, hosts.len()) {
                add(h.trim(), p, &mut out);
            }
        }
        for (i, h) in hostaddrs.iter().enumerate() {
            for p in port_for(i, hostaddrs.len()) {
                if !h.trim().is_empty() {
                    add(h.trim(), p, &mut out);
                }
            }
        }
        out
    }
}

/// The environment's host list when the string names no host (empty entries do not count), and
/// its ports when the string names no port.
fn fold_defaults(
    hosts: Vec<String>,
    hostaddrs: &[String],
    ports: Vec<String>,
    defaults: &Defaults,
) -> (Vec<String>, Vec<String>) {
    let named = hosts.iter().chain(hostaddrs).any(|h| !h.trim().is_empty());
    let hosts = if named || defaults.hosts.is_empty() { hosts } else { defaults.hosts.clone() };
    let ports = if ports.iter().any(|p| !p.trim().is_empty()) { ports } else { defaults.ports.clone() };
    (hosts, ports)
}

/// `key=value ...` and not another URL form (`sqlite:file?mode=rwc` has an `=` too).
fn is_conninfo(input: &str) -> bool {
    input.split_once('=').is_some_and(|(key, _)| !key.contains([':', '/', '?']))
}

fn push_unique(list: &mut Vec<(String, u16)>, entry: (String, u16)) {
    if !list.contains(&entry) {
        list.push(entry);
    }
}

/// `rest` is a URL after its scheme: `[user[:password]@]hosts[/database][?parameters]`.
fn url_parts(rest: &str) -> Parts {
    let rest = rest.split('#').next().unwrap_or(rest);
    let (before_query, query) = rest.split_once('?').unwrap_or((rest, ""));
    let authority = before_query.split('/').next().unwrap_or("");
    // The password may hold a raw `@`; the host list starts after the last one.
    let hostlist = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let (mut hosts, mut ports) = (Vec::new(), Vec::new());
    let mut missing_port = false;
    for entry in split_top(hostlist) {
        let (host, port) = split_host_port(&entry);
        if host.is_empty() && port.is_none() {
            continue;
        }
        hosts.push(decode(&host));
        match port {
            Some(p) => ports.push(p),
            None => missing_port = true,
        }
    }
    // A host without a port next to hosts with one uses the default: keep positions aligned.
    if missing_port && !ports.is_empty() {
        ports = split_top(hostlist)
            .iter()
            .map(|e| split_host_port(e).1.unwrap_or_else(|| DEFAULT_PORT.to_string()))
            .collect();
    }
    let (mut hostaddrs, mut query_ports) = (Vec::new(), Vec::new());
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        // libpq decodes the names as well as the values: `?%68ost=` is `host`.
        let (key, value) = (decode(key), decode(value));
        match key.as_str() {
            "host" => hosts.extend(value.split(',').map(str::to_string)),
            "hostaddr" => hostaddrs.extend(value.split(',').map(str::to_string)),
            "port" => query_ports.extend(value.split(',').map(str::to_string)),
            _ => {}
        }
    }
    // The parameter overrides the authority in libpq; both are protected.
    ports.extend(query_ports);
    (hosts, hostaddrs, ports)
}

/// Splits `a:1,[::1]:2,b` at the commas outside brackets.
fn split_top(list: &str) -> Vec<String> {
    let (mut out, mut depth, mut cur) = (Vec::new(), 0, String::new());
    for c in list.chars() {
        match c {
            '[' => depth += 1,
            ']' => depth -= 1,
            ',' if depth <= 0 => {
                out.push(std::mem::take(&mut cur));
                continue;
            }
            _ => {}
        }
        cur.push(c);
    }
    out.push(cur);
    out
}

fn split_host_port(entry: &str) -> (String, Option<String>) {
    if let Some(rest) = entry.strip_prefix('[') {
        return match rest.split_once(']') {
            Some((host, tail)) => (host.to_string(), tail.strip_prefix(':').map(str::to_string)),
            None => (rest.to_string(), None),
        };
    }
    match entry.rsplit_once(':') {
        Some((host, port)) => (host.to_string(), Some(port.to_string())),
        None => (entry.to_string(), None),
    }
}

fn decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && let Some(v) = s.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok())
        {
            out.push(v);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A key=value string: `key = value` pairs split by white space, values optionally in single
/// quotes with backslash escapes. `None` when it is malformed (no value or an open quote).
fn conninfo_parts(input: &str) -> Option<Parts> {
    let chars: Vec<char> = input.chars().collect();
    let (mut i, mut pairs) = (0, Vec::new());
    while i < chars.len() {
        while i < chars.len() && chars[i].is_whitespace() {
            i += 1;
        }
        if i >= chars.len() {
            break;
        }
        let start = i;
        while i < chars.len() && chars[i] != '=' && !chars[i].is_whitespace() {
            i += 1;
        }
        let key: String = chars[start..i].iter().collect();
        while i < chars.len() && chars[i].is_whitespace() {
            i += 1;
        }
        if i >= chars.len() || chars[i] != '=' {
            return None;
        }
        i += 1;
        while i < chars.len() && chars[i].is_whitespace() {
            i += 1;
        }
        let mut value = String::new();
        if i < chars.len() && chars[i] == '\'' {
            i += 1;
            loop {
                match chars.get(i)? {
                    '\\' => {
                        value.push(*chars.get(i + 1)?);
                        i += 2;
                    }
                    '\'' => {
                        i += 1;
                        break;
                    }
                    c => {
                        value.push(*c);
                        i += 1;
                    }
                }
            }
        } else {
            while i < chars.len() && !chars[i].is_whitespace() {
                if chars[i] == '\\' && i + 1 < chars.len() {
                    i += 1;
                }
                value.push(chars[i]);
                i += 1;
            }
        }
        pairs.push((key, value));
    }
    let list = |name: &str| {
        pairs
            .iter()
            .filter(|(k, _)| k == name)
            .flat_map(|(_, v)| v.split(',').map(str::to_string).collect::<Vec<_>>())
            .collect::<Vec<_>>()
    };
    Some((list("host"), list("hostaddr"), list("port")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tcp(input: &str) -> Vec<(String, u16)> {
        Location::parse(input).unwrap().tcp
    }

    fn pair(h: &str, p: u16) -> (String, u16) {
        (h.to_string(), p)
    }

    #[test]
    fn a_single_host_url() {
        assert_eq!(tcp("postgres://k:p@db.internal:6543/kalzit"), vec![pair("db.internal", 6543)]);
        assert_eq!(tcp("postgresql://db.internal/kalzit"), vec![pair("db.internal", 5432)]);
        assert_eq!(tcp("POSTGRES://k:p%40x@db/k"), vec![pair("db", 5432)]);
        // A raw `@` in the password.
        assert_eq!(tcp("postgres://k:p@ss@db:1/k"), vec![pair("db", 1)]);
    }

    #[test]
    fn multi_host_urls() {
        assert_eq!(tcp("postgres://h1:1,h2:2/db"), vec![pair("h1", 1), pair("h2", 2)]);
        // A host without a port has the default, as in libpq.
        assert_eq!(tcp("postgres://h1,h2:7/db"), vec![pair("h1", 5432), pair("h2", 7)]);
        // The parameter overrides in libpq; every combination is protected.
        let t = tcp("postgres://h1:1,h2:2/db?port=8");
        for want in [("h1", 1), ("h2", 2), ("h1", 8), ("h2", 8)] {
            assert!(t.contains(&pair(want.0, want.1)), "{want:?}");
        }
        assert_eq!(tcp("postgres://h1,h2/db?port=3,4"), vec![pair("h1", 3), pair("h2", 4)]);
    }

    #[test]
    fn query_parameters() {
        assert_eq!(tcp("postgres:///db?host=other&port=6000"), vec![pair("other", 6000)]);
        let t = tcp("postgres://h1/db?host=h2,h3&hostaddr=10.0.0.1,10.0.0.2&port=5433");
        for want in [("h1", 5433), ("h2", 5433), ("h3", 5433), ("10.0.0.1", 5433), ("10.0.0.2", 5433)] {
            assert!(t.contains(&pair(want.0, want.1)), "{want:?}");
        }
        assert_eq!(tcp("postgres://h/db?sslmode=disable"), vec![pair("h", 5432)]);
    }

    #[test]
    fn ipv6() {
        assert_eq!(tcp("postgres://[::1]:6000/db"), vec![pair("::1", 6000)]);
        assert_eq!(tcp("postgres://[::1],[fe80::2]:9/db"), vec![pair("::1", 5432), pair("fe80::2", 9)]);
        assert_eq!(tcp("postgres://[2001:db8::1]/db"), vec![pair("2001:db8::1", 5432)]);
    }

    #[test]
    fn key_value_strings() {
        assert_eq!(tcp("host=db.internal port=6543 dbname=k user=k"), vec![pair("db.internal", 6543)]);
        assert_eq!(tcp("host = 'h1,h2' port='1,2'"), vec![pair("h1", 1), pair("h2", 2)]);
        assert_eq!(tcp("hostaddr=192.0.2.5 host=db"), vec![pair("db", 5432), pair("192.0.2.5", 5432)]);
        assert_eq!(tcp("dbname=k"), vec![pair("localhost", 5432)]);
        assert_eq!(Location::parse("host='unterminated"), None);
    }

    #[test]
    fn unix_sockets() {
        let l = Location::parse("postgres://%2Fvar%2Frun%2Fpostgresql:5433/db").unwrap();
        assert_eq!(l.sockets, vec![PathBuf::from("/var/run/postgresql/.s.PGSQL.5433")]);
        assert_eq!(l.tcp, vec![pair("localhost", 5433)]);
        let l = Location::parse("postgres:///db?host=/tmp").unwrap();
        assert!(l.sockets.contains(&PathBuf::from("/tmp/.s.PGSQL.5432")));
        let l = Location::parse("host=/tmp port=1").unwrap();
        assert_eq!(l.sockets, vec![PathBuf::from("/tmp/.s.PGSQL.1")]);
        // No host: the default socket and localhost.
        let l = Location::parse("postgres:///db").unwrap();
        assert_eq!(l.tcp, vec![pair("localhost", 5432)]);
        assert_eq!(l.sockets.len(), 1);
    }

    #[test]
    fn other_databases_are_not_postgres() {
        assert_eq!(Location::parse("sqlite:C:/data/kalzit.db?mode=rwc"), None);
        assert_eq!(Location::parse("mysql://h/db"), None);
    }

    #[test]
    fn percent_encoded_parameter_names() {
        // libpq decodes the names too: these are `host`, `hostaddr` and `port`.
        let t = tcp("postgres://h1/db?%68ost=h2&%68%6F%73%74addr=192.0.2.4&%70ort=6001");
        for want in [("h1", 6001), ("h2", 6001), ("192.0.2.4", 6001)] {
            assert!(t.contains(&pair(want.0, want.1)), "{want:?} in {t:?}");
        }
        assert!(!t.contains(&pair("h1", 5432)), "{t:?}");
    }

    #[test]
    fn environment_defaults_fill_what_the_string_leaves_out() {
        let env = Defaults { hosts: vec!["envhost".into(), "192.0.2.8".into()], ports: vec!["6002".into()] };
        let tcp_with = |input: &str| Location::parse_with(input, &env).unwrap().tcp;
        assert_eq!(tcp_with("postgres:///db"), vec![pair("envhost", 6002), pair("192.0.2.8", 6002)]);
        assert_eq!(tcp_with("dbname=k"), vec![pair("envhost", 6002), pair("192.0.2.8", 6002)]);
        // What the string names wins, as in libpq.
        assert_eq!(tcp_with("postgres://h:7/db"), vec![pair("h", 7)]);
        assert_eq!(tcp_with("postgres://h/db"), vec![pair("h", 6002)]);
        assert_eq!(tcp_with("postgres://:7/db"), vec![pair("envhost", 7), pair("192.0.2.8", 7)]);
    }

    #[test]
    fn the_own_database_fails_closed() {
        assert_eq!(own_database("sqlite:C:/data/kalzit.db?mode=rwc"), None);
        assert_eq!(own_database(" SQLite:kalzit.db"), None);
        let readable = own_database("POSTGRESQL://db.internal:6543/k").unwrap();
        assert!(!readable.unknown);
        assert!(readable.tcp.contains(&pair("db.internal", 6543)));
        // Neither SQLite nor a readable PostgreSQL string: nothing is known, nothing is let through.
        let unknown = own_database("host='unterminated").unwrap();
        assert!(unknown.unknown && unknown.tcp.is_empty());
        assert!(own_database("mysql://h/db").unwrap().unknown);
        assert!(is_postgres_url("PostgreSQL://h/db") && is_postgres_url("postgres:///db"));
        assert!(!is_postgres_url("sqlite::memory:"));
    }
}
