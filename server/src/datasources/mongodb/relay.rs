//! The MongoDB driver resolves host names and connects on its own, also to replica set members a
//! server names in its answers. So that every one of those connections passes the target rules,
//! the driver talks to a small SOCKS5 relay on the loopback interface: the driver hands it the
//! host name, the relay resolves and checks it (`TargetPolicy::connect`) and connects to the
//! checked address. TLS runs end to end through the relay with the real host name, so
//! certificates are checked against the name as usual.
//!
//! Each client has its own relay with random credentials, so no other local process can use it,
//! and it stops when the client is dropped.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Semaphore;

use crate::datasources::Detail;
use crate::datasources::targets::{ResolveError, TargetPolicy};

/// How long the driver has for the SOCKS handshake.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// Handshakes in progress at once; further connections wait for a slot, so a flood of idle
/// connections cannot hold many tasks and buffers.
const MAX_HANDSHAKES: usize = 64;

/// Why the relay did not connect: a refused target, or a name that does not resolve or answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Refusal {
    Blocked(Detail),
    Failed(Detail),
}

/// Refusals in order: each gets the next number, so an operation reads only those that happened
/// after it started (`mark`, `refusal_since`).
#[derive(Default)]
struct Refusals {
    count: u64,
    last: Option<Refusal>,
}

pub struct Relay {
    port: u16,
    username: String,
    password: String,
    refusals: Arc<Mutex<Refusals>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Relay {
    fn drop(&mut self) {
        // Aborting the accept loop drops its JoinSet, which aborts every open tunnel.
        self.task.abort();
    }
}

impl Relay {
    /// Listens on a free loopback port and forwards to targets `policy` allows.
    pub async fn start(policy: Arc<TargetPolicy>, connect_timeout: Duration) -> std::io::Result<Self> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
        let port = listener.local_addr()?.port();
        let username = hex::encode(rand::random::<[u8; 8]>());
        let password = hex::encode(rand::random::<[u8; 24]>());
        let refusals = Arc::new(Mutex::new(Refusals::default()));
        let creds = Arc::new((username.clone(), password.clone()));
        let shared = refusals.clone();
        let handshakes = Arc::new(Semaphore::new(MAX_HANDSHAKES));
        let task = tokio::spawn(async move {
            let mut tunnels = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let Ok((stream, _)) = accepted else { continue };
                        let (creds, policy, refusals) = (creds.clone(), policy.clone(), shared.clone());
                        let handshakes = handshakes.clone();
                        tunnels.spawn(async move {
                            if let Err(e) = tunnel(stream, &creds, &policy, &refusals, &handshakes, connect_timeout).await {
                                tracing::debug!("MongoDB relay: {e}");
                            }
                        });
                    }
                    Some(_) = tunnels.join_next() => {}
                }
            }
        });
        Ok(Self { port, username, password, refusals, task })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// The credentials the driver presents.
    pub fn credentials(&self) -> (String, String) {
        (self.username.clone(), self.password.clone())
    }

    /// A mark to take before an operation; `refusal_since` then reports only what happened during
    /// it, not an older refusal of another operation or replica set member.
    pub fn mark(&self) -> u64 {
        self.refusals.lock().expect("relay refusal lock").count
    }

    /// The last target the relay refused or could not reach after `mark`, if any.
    pub fn refusal_since(&self, mark: u64) -> Option<Refusal> {
        let r = self.refusals.lock().expect("relay refusal lock");
        if r.count > mark { r.last.clone() } else { None }
    }
}

/// Compares without stopping at the first difference.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// One SOCKS5 connection (RFC 1928 with username and password, RFC 1929): CONNECT only.
async fn tunnel(
    mut client: TcpStream,
    creds: &(String, String),
    policy: &TargetPolicy,
    refusals: &Mutex<Refusals>,
    handshakes: &Semaphore,
    connect_timeout: Duration,
) -> std::io::Result<()> {
    let target = {
        let _slot = handshakes.acquire().await.map_err(|_| std::io::Error::other("the relay is closing"))?;
        tokio::time::timeout(HANDSHAKE_TIMEOUT, handshake(&mut client, creds))
            .await
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "SOCKS handshake timed out"))??
    };
    let Some((host, port)) = target else { return Ok(()) };
    match policy.connect(&host, port, connect_timeout).await {
        Ok((_, mut upstream)) => {
            upstream.set_nodelay(true)?;
            client.write_all(&reply(0)).await?;
            tokio::io::copy_bidirectional(&mut client, &mut upstream).await?;
            Ok(())
        }
        Err(e) => {
            let (code, kept) = match e {
                ResolveError::Blocked(b) => (2, Refusal::Blocked(b.0)),
                other => (4, Refusal::Failed(other.detail())),
            };
            {
                let mut r = refusals.lock().expect("relay refusal lock");
                r.count += 1;
                r.last = Some(kept);
            }
            client.write_all(&reply(code)).await?;
            Ok(())
        }
    }
}

/// `VER REP RSV ATYP BND.ADDR BND.PORT` with an empty IPv4 bind address.
fn reply(code: u8) -> [u8; 10] {
    [5, code, 0, 1, 0, 0, 0, 0, 0, 0]
}

/// Greeting, authentication and the request. `None` when the client was turned away.
async fn handshake(client: &mut TcpStream, creds: &(String, String)) -> std::io::Result<Option<(String, u16)>> {
    let mut head = [0u8; 2];
    client.read_exact(&mut head).await?;
    if head[0] != 5 {
        return Ok(None);
    }
    let mut methods = vec![0u8; head[1] as usize];
    client.read_exact(&mut methods).await?;
    if !methods.contains(&2) {
        client.write_all(&[5, 0xFF]).await?;
        return Ok(None);
    }
    client.write_all(&[5, 2]).await?;
    let mut ver = [0u8; 2];
    client.read_exact(&mut ver).await?;
    let mut user = vec![0u8; ver[1] as usize];
    client.read_exact(&mut user).await?;
    let mut len = [0u8; 1];
    client.read_exact(&mut len).await?;
    let mut pass = vec![0u8; len[0] as usize];
    client.read_exact(&mut pass).await?;
    // Both are compared in full, so the time does not tell which one was wrong.
    let ok = same(&user, creds.0.as_bytes()) & same(&pass, creds.1.as_bytes());
    if ver[0] != 1 || !ok {
        client.write_all(&[1, 1]).await?;
        return Ok(None);
    }
    client.write_all(&[1, 0]).await?;
    let mut req = [0u8; 4];
    client.read_exact(&mut req).await?;
    if req[0] != 5 || req[1] != 1 {
        client.write_all(&reply(7)).await?;
        return Ok(None);
    }
    let host = match req[3] {
        1 => {
            let mut ip = [0u8; 4];
            client.read_exact(&mut ip).await?;
            IpAddr::V4(Ipv4Addr::from(ip)).to_string()
        }
        3 => {
            let mut n = [0u8; 1];
            client.read_exact(&mut n).await?;
            let mut name = vec![0u8; n[0] as usize];
            client.read_exact(&mut name).await?;
            match String::from_utf8(name) {
                Ok(name) => name,
                Err(_) => {
                    client.write_all(&reply(8)).await?;
                    return Ok(None);
                }
            }
        }
        4 => {
            let mut ip = [0u8; 16];
            client.read_exact(&mut ip).await?;
            IpAddr::V6(Ipv6Addr::from(ip)).to_string()
        }
        _ => {
            client.write_all(&reply(8)).await?;
            return Ok(None);
        }
    };
    let mut port = [0u8; 2];
    client.read_exact(&mut port).await?;
    Ok(Some((host, u16::from_be_bytes(port))))
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn socks_connect(relay: &Relay, user: &str, pass: &str, host: &str, port: u16) -> (TcpStream, Vec<u8>) {
        let mut s = TcpStream::connect((Ipv4Addr::LOCALHOST, relay.port())).await.unwrap();
        s.write_all(&[5, 1, 2]).await.unwrap();
        let mut m = [0u8; 2];
        s.read_exact(&mut m).await.unwrap();
        assert_eq!(m, [5, 2]);
        let mut auth = vec![1, user.len() as u8];
        auth.extend(user.as_bytes());
        auth.push(pass.len() as u8);
        auth.extend(pass.as_bytes());
        s.write_all(&auth).await.unwrap();
        let mut a = [0u8; 2];
        s.read_exact(&mut a).await.unwrap();
        if a != [1, 0] {
            return (s, a.to_vec());
        }
        let mut req = vec![5, 1, 0, 3, host.len() as u8];
        req.extend(host.as_bytes());
        req.extend(port.to_be_bytes());
        s.write_all(&req).await.unwrap();
        let mut r = [0u8; 10];
        s.read_exact(&mut r).await.unwrap();
        (s, r.to_vec())
    }

    fn policy() -> Arc<TargetPolicy> {
        let dir = std::env::temp_dir();
        Arc::new(TargetPolicy::new(&dir, "sqlite::memory:", &[], &[]))
    }

    #[tokio::test]
    async fn forwards_to_allowed_targets_only_with_its_credentials() {
        let echo = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let echo_port = echo.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut s, _) = echo.accept().await.unwrap();
            let mut buf = [0u8; 5];
            s.read_exact(&mut buf).await.unwrap();
            s.write_all(&buf).await.unwrap();
        });
        let relay = Relay::start(policy(), Duration::from_secs(2)).await.unwrap();
        let (user, pass) = relay.credentials();

        let (_, answer) = socks_connect(&relay, &user, "falsch", "localhost", echo_port).await;
        assert_eq!(answer, [1, 1], "a wrong password is turned away");

        let (mut s, answer) = socks_connect(&relay, &user, &pass, "127.0.0.1", echo_port).await;
        assert_eq!(answer[1], 0, "{answer:?}");
        s.write_all(b"hallo").await.unwrap();
        let mut back = [0u8; 5];
        s.read_exact(&mut back).await.unwrap();
        assert_eq!(&back, b"hallo");
        assert_eq!(relay.refusal_since(0), None);

        // The metadata address is refused, by address and by a name that resolves to it.
        let (_, answer) = socks_connect(&relay, &user, &pass, "169.254.169.254", 80).await;
        assert_eq!(answer[1], 2, "{answer:?}");
        match relay.refusal_since(0) {
            Some(Refusal::Blocked(d)) => assert_eq!(d.reason, "target.metadata_address"),
            other => panic!("{other:?}"),
        }
    }

    #[tokio::test]
    async fn the_allow_list_applies_to_every_member() {
        let dir = std::env::temp_dir();
        let policy = Arc::new(TargetPolicy::new(&dir, "sqlite::memory:", &[], &["10.0.0.0/8".to_string()]));
        let relay = Relay::start(policy, Duration::from_secs(2)).await.unwrap();
        let (user, pass) = relay.credentials();
        let (_, answer) = socks_connect(&relay, &user, &pass, "127.0.0.1", 27017).await;
        assert_eq!(answer[1], 2);
        match relay.refusal_since(0) {
            Some(Refusal::Blocked(d)) => assert_eq!(d.reason, "target.not_allowed"),
            other => panic!("{other:?}"),
        }
    }

    #[tokio::test]
    async fn a_refusal_belongs_to_the_operation_it_happened_in() {
        let relay = Relay::start(policy(), Duration::from_secs(2)).await.unwrap();
        let (user, pass) = relay.credentials();
        let before = relay.mark();
        let (_, answer) = socks_connect(&relay, &user, &pass, "169.254.169.254", 80).await;
        assert_eq!(answer[1], 2);
        assert!(matches!(relay.refusal_since(before), Some(Refusal::Blocked(_))));
        // A later operation does not inherit it.
        let later = relay.mark();
        assert_eq!(relay.refusal_since(later), None);
    }

    #[tokio::test]
    async fn handshakes_in_progress_are_capped() {
        let relay = Relay::start(policy(), Duration::from_secs(2)).await.unwrap();
        // Idle connections that never finish their greeting hold every handshake slot.
        let mut idle = Vec::new();
        for _ in 0..MAX_HANDSHAKES {
            idle.push(TcpStream::connect((Ipv4Addr::LOCALHOST, relay.port())).await.unwrap());
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
        let mut waiting = TcpStream::connect((Ipv4Addr::LOCALHOST, relay.port())).await.unwrap();
        waiting.write_all(&[5, 1, 2]).await.unwrap();
        let mut m = [0u8; 2];
        let early = tokio::time::timeout(Duration::from_millis(300), waiting.read_exact(&mut m)).await;
        assert!(early.is_err(), "the connection past the cap waits for a slot");
        drop(idle.pop());
        tokio::time::timeout(Duration::from_secs(5), waiting.read_exact(&mut m)).await.unwrap().unwrap();
        assert_eq!(m, [5, 2], "a freed slot lets it through");
    }

    #[tokio::test]
    async fn stops_listening_when_dropped() {
        let relay = Relay::start(policy(), Duration::from_secs(2)).await.unwrap();
        let port = relay.port();
        drop(relay);
        tokio::task::yield_now().await;
        // The listener is gone once the aborted task has been dropped.
        let mut gone = false;
        for _ in 0..50 {
            if TcpStream::connect((Ipv4Addr::LOCALHOST, port)).await.is_err() {
                gone = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(gone);
    }
}
