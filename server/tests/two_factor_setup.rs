//! First-run setup with a second factor required by the environment: the first owner sets one up
//! before a session opens, as at any sign-in. A test binary of its own, since the rule comes from
//! the process environment and would apply to every other test in the same process.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::connect_info::MockConnectInfo;
use axum::http::{Request, StatusCode, header};
use http_body_util::BodyExt;
use kalzit::app::{AppState, router};
use kalzit::clock::ManualClock;
use kalzit::config::Config;
use serde_json::{Value, json};
use tower::ServiceExt;

mod common;

const SETUP_CODE: &str = "test-setup-code-0123456789";

#[tokio::test]
async fn setup_honours_a_required_second_factor() {
    // SAFETY: this binary has this one test, so no other thread reads the environment meanwhile.
    unsafe { std::env::set_var("KALZIT_SETTING_SECURITY_TWO_FACTOR_REQUIRED", "everyone") };
    let dir = Arc::new(tempfile::tempdir().unwrap());
    let mut config = Config::default();
    config.paths.data_dir = dir.path().to_path_buf();
    let pool = kalzit::db::connect(&config.database_url(), 4).await.unwrap();
    let clock = Arc::new(ManualClock::new(1_800_000_015_000));
    let state = AppState::new(config, pool, clock, Some(SETUP_CODE.into())).await.unwrap();
    let peer: SocketAddr = "127.0.0.1:50000".parse().unwrap();
    let app = router(state.clone()).layer(MockConnectInfo(peer));

    let send = |method: &str, path: &str, body: Option<Value>, cookie: Option<String>| {
        let mut req = Request::builder().method(method).uri(path).header(header::HOST, "kalzit.test");
        if let Some(cookie) = cookie {
            req = req.header(header::COOKIE, cookie);
        }
        let body = match body {
            Some(b) => {
                req = req.header(header::CONTENT_TYPE, "application/json");
                Body::from(b.to_string())
            }
            None => Body::empty(),
        };
        let app = app.clone();
        let req = req.body(body).unwrap();
        async move {
            let res = app.oneshot(req).await.unwrap();
            let status = res.status();
            let cookies: Vec<String> = res
                .headers()
                .get_all(header::SET_COOKIE)
                .iter()
                .map(|v| v.to_str().unwrap().split(';').next().unwrap().to_string())
                .collect();
            let bytes = res.into_body().collect().await.unwrap().to_bytes();
            (status, cookies, serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null))
        }
    };

    let body = json!({ "token": SETUP_CODE, "orgName": "Müller & Söhne", "name": "Jörg Müller",
                       "email": "joerg@example.de", "password": "Grün und sicher 2026" });
    let (status, cookies, answer) = send("POST", "/api/setup", Some(body), None).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    assert_eq!(answer["secondFactor"]["setup"], true, "{answer}");
    assert_eq!(answer["secondFactor"]["requiredBy"]["kind"], "server");
    assert!(cookies.iter().all(|c| !c.starts_with("kalzit_session=")), "no session before the second factor");
    let pending = cookies.into_iter().find(|c| c.starts_with("kalzit_pending=")).expect("pending cookie");
    let (status, _, _) = send("GET", "/api/me", None, Some(pending.clone())).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, _, setup) =
        send("POST", "/api/auth/second-factor/setup/totp", Some(json!({})), Some(pending.clone())).await;
    assert_eq!(status, StatusCode::OK, "{setup}");
    let secret = kalzit::auth::totp::decode_secret(&setup["secret"].as_str().unwrap().replace(' ', "")).unwrap();
    let code = kalzit::auth::totp::code_at(&secret, kalzit::auth::totp::step_at(1_800_000_015_000));
    let (status, cookies, done) =
        send("POST", "/api/auth/second-factor/setup", Some(json!({ "method": "totp", "code": code })), Some(pending))
            .await;
    assert_eq!(status, StatusCode::OK, "{done}");
    assert_eq!(done["me"]["isServerAdmin"], true);
    assert!(cookies.iter().any(|c| c.starts_with("kalzit_session=")));

    drop(app);
    common::Finish::new(state, dir).finish().await;
}
