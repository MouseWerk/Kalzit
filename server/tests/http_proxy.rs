//! Data source HTTP traffic ignores proxy variables: a proxy would resolve names itself, past
//! the target check. Its own test binary, because it changes the process environment.

use std::sync::Arc;
use std::time::Duration;

use kalzit::datasources::targets::TargetPolicy;
use kalzit::http::{HttpOptions, client};
use reqwest::header::HeaderMap;
use reqwest::{Method, Url};

#[tokio::test]
async fn proxy_variables_are_ignored() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let (mut s, _) = listener.accept().await.unwrap();
        let mut buf = [0u8; 1024];
        let _ = s.read(&mut buf).await;
        s.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 6\r\nconnection: close\r\n\r\ndirekt").await.unwrap();
    });
    for name in ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"] {
        // SAFETY: this test binary has a single test, so nothing reads the environment meanwhile.
        unsafe { std::env::set_var(name, "http://127.0.0.1:9") };
    }
    let policy = TargetPolicy::new(&std::env::temp_dir().join("kalzit-none"), "sqlite::memory:", &[], &[]);
    let c = client(HttpOptions { timeout: Duration::from_secs(5), extra_root_pem: None, policy: Arc::new(policy) })
        .unwrap();
    let r = c.send(Method::GET, Url::parse(&format!("http://{addr}/")).unwrap(), HeaderMap::new()).await.unwrap();
    assert_eq!(r.text().await.unwrap(), "direkt", "the request went to the target, not to the proxy");
}
