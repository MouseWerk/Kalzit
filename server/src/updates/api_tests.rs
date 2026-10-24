//! The update routes through the real router: a fake GitHub, test signing keys, a fake binary in
//! a temporary folder. Nothing here starts a real binary or restarts the test process: a
//! handover is only recorded.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::connect_info::MockConnectInfo;
use axum::http::{Method, Request, StatusCode, header};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

use super::install;
use super::platform::{Mode, Platform};
use super::signing::tests::{keys_for, signed_manifest, test_key};
use super::source::tests::{local_source, serve_releases};
use crate::app::{AppState, router};
use crate::clock::ManualClock;
use crate::config::Config;

const SETUP_CODE: &str = "test-setup-code-0123456789";
const PASSWORD: &str = "Grün und sicher 2026";
const NOW: i64 = 1_800_000_000_000;

struct T {
    app: Router,
    state: AppState,
    clock: Arc<ManualClock>,
    admin: String,
    exe: PathBuf,
    dir: tempfile::TempDir,
}

struct Reply {
    status: StatusCode,
    body: Value,
    text: String,
}

impl Reply {
    fn reason(&self) -> &str {
        self.body["error"]["reason"].as_str().unwrap_or("")
    }
}

impl T {
    async fn new(source: Option<SocketAddr>, mode: Mode) -> T {
        let dir = tempfile::tempdir().unwrap();
        let mut config = Config::default();
        config.paths.data_dir = dir.path().join("data");
        std::fs::create_dir_all(&config.paths.data_dir).unwrap();
        let pool = crate::db::connect(&config.database_url(), 4).await.unwrap();
        let clock = Arc::new(ManualClock::new(NOW));
        let state = AppState::new(config, pool, clock.clone(), Some(SETUP_CODE.into())).await.unwrap();
        let exe = dir.path().join("bin").join(if cfg!(windows) { "kalzit.exe" } else { "kalzit" });
        std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
        std::fs::write(&exe, "running binary").unwrap();
        let source = local_source(source.unwrap_or_else(|| "127.0.0.1:9".parse().unwrap()));
        state.updates.set_test_environment(source, keys_for(&test_key(1)), exe.clone(), mode);
        let peer: SocketAddr = "127.0.0.1:50000".parse().unwrap();
        let app = router(state.clone()).layer(MockConnectInfo(peer));
        let mut t = T { app, state, clock, admin: String::new(), exe, dir };
        let r = t
            .send(
                Method::POST,
                "/api/setup",
                Some(json!({ "token": SETUP_CODE, "orgName": "Müller & Söhne", "name": "Jörg",
                             "email": "joerg@example.de", "password": PASSWORD })),
                None,
            )
            .await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.text);
        let (id,): (String,) = sqlx::query_as("SELECT id FROM users").fetch_one(&t.state.db).await.unwrap();
        let token = crate::auth::session::create(&t.state.db, &t.state.config.sessions, NOW, &id).await.unwrap();
        t.admin = format!("kalzit_session={token}");
        t
    }

    async fn finish(self) {
        let T { app, state, dir, .. } = self;
        drop(app);
        crate::app::finish_test_app(state, dir).await;
    }

    async fn send(&self, method: Method, path: &str, body: Option<Value>, cookie: Option<&str>) -> Reply {
        let mut req = Request::builder().method(method).uri(path).header(header::HOST, "kalzit.test");
        if let Some(c) = cookie {
            req = req.header(header::COOKIE, c);
        }
        let req = match body {
            Some(b) => req.header(header::CONTENT_TYPE, "application/json").body(Body::from(b.to_string())),
            None => req.body(Body::empty()),
        }
        .unwrap();
        self.reply(req).await
    }

    async fn reply(&self, req: Request<Body>) -> Reply {
        let res = self.app.clone().oneshot(req).await.unwrap();
        let status = res.status();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        let text = String::from_utf8_lossy(&bytes).to_string();
        let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        Reply { status, body, text }
    }

    async fn get(&self) -> Reply {
        self.send(Method::GET, "/api/admin/updates", None, Some(&self.admin)).await
    }

    async fn post(&self, rest: &str, body: Value) -> Reply {
        self.send(Method::POST, &format!("/api/admin/updates{rest}"), Some(body), Some(&self.admin)).await
    }

    /// Uploads parts (name, bytes) as multipart.
    async fn upload(&self, parts: &[(&str, &[u8])]) -> Reply {
        let boundary = "kalzit-test-boundary";
        let mut body = Vec::new();
        for (name, bytes) in parts {
            body.extend_from_slice(
                format!(
                    "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"; filename=\"{name}.bin\"\r\n\
                     Content-Type: application/octet-stream\r\n\r\n"
                )
                .as_bytes(),
            );
            body.extend_from_slice(bytes);
            body.extend_from_slice(b"\r\n");
        }
        body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
        let req = Request::builder()
            .method(Method::POST)
            .uri("/api/admin/updates/upload")
            .header(header::HOST, "kalzit.test")
            .header(header::COOKIE, &self.admin)
            .header(header::CONTENT_TYPE, format!("multipart/form-data; boundary={boundary}"))
            .body(Body::from(body))
            .unwrap();
        self.reply(req).await
    }

    async fn audit_actions(&self) -> Vec<String> {
        let rows: Vec<(String,)> =
            sqlx::query_as("SELECT action FROM audit_events WHERE action LIKE 'update.%' ORDER BY created_at, id")
                .fetch_all(&self.state.db)
                .await
                .unwrap();
        rows.into_iter().map(|(a,)| a).collect()
    }

    fn exe_content(&self) -> String {
        std::fs::read_to_string(&self.exe).unwrap()
    }
}

fn platform() -> Platform {
    Platform::current()
}

/// A release for this platform signed with the trusted test key.
fn release(version: &str, package: &[u8]) -> (Vec<u8>, Vec<u8>) {
    let p = platform();
    signed_manifest(&test_key(1), version, &[(p.os, p.arch, package)])
}

#[tokio::test]
async fn check_download_and_apply_hand_over_to_the_new_binary() {
    let server = serve_releases(&test_key(1), &[("99.1.0", false, b"new kalzit binary")], &[]).await;
    let t = T::new(Some(server), Mode::Automatic).await;
    let r = t.post("/check", json!(null)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.body["available"]["version"], "99.1.0", "{}", r.text);
    assert_eq!(r.body["available"]["size"], 17);
    assert_eq!(r.body["available"]["staged"], false);
    assert_eq!(r.body["installed"]["version"], env!("CARGO_PKG_VERSION"));

    let r = t.post("/download", json!({ "version": "99.1.0" })).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    loop {
        let s = t.get().await;
        if s.body["staged"]["version"] == "99.1.0" && s.body["job"]["phase"] == "idle" {
            break;
        }
        assert!(std::time::Instant::now() < deadline, "the download did not finish: {}", s.text);
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    let r = t.post("/apply", json!({ "version": "99.1.0" })).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.body["job"]["phase"], "restarting", "{}", r.text);
    assert_eq!(t.exe_content(), "new kalzit binary");
    let handover = t.state.updates.take_handover().expect("a handover");
    assert_eq!(handover.exe, t.exe);
    assert!(handover.restore.is_none());
    let plan = install::read_plan(t.state.updates.layout()).unwrap();
    assert_eq!((plan.to.as_str(), plan.state), ("99.1.0", install::PlanState::Swapped));
    let backup = plan.backup.as_deref().and_then(|b| install::backup_path(t.state.updates.layout(), b));
    assert!(backup.is_some(), "the database was backed up first");
    let kept = install::kept_binary(t.state.updates.layout(), env!("CARGO_PKG_VERSION"), &t.exe).unwrap();
    assert_eq!(std::fs::read_to_string(kept).unwrap(), "running binary");
    assert_eq!(t.audit_actions().await, ["update.checked", "update.downloaded", "update.applied"]);
    t.finish().await;
}

#[tokio::test]
async fn a_check_failure_is_reported_with_its_reason() {
    let stranger = test_key(2);
    let server = serve_releases(&stranger, &[("99.1.0", false, b"x")], &[]).await;
    let t = T::new(Some(server), Mode::Automatic).await;
    let r = t.post("/check", json!(null)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert!(r.body["available"].is_null());
    assert_eq!(r.body["lastCheck"]["error"]["reason"], "updates.unknown_key", "{}", r.text);
    let r = t.post("/download", json!({ "version": "99.1.0" })).await;
    assert_eq!((r.status, r.reason()), (StatusCode::CONFLICT, "updates.not_offered"), "{}", r.text);
    t.finish().await;
}

#[tokio::test]
async fn an_offline_upload_is_verified_like_a_download() {
    let t = T::new(None, Mode::Automatic).await;
    let (manifest, sig) = release("99.2.0", b"offline binary");
    let r = t.upload(&[("manifest", &manifest), ("signature", &sig), ("package", b"offline binary")]).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.body["staged"]["version"], "99.2.0");
    assert_eq!(r.body["staged"]["source"], "offline");

    let r = t.upload(&[("manifest", &manifest), ("signature", &sig), ("package", b"offline binarY")]).await;
    assert_eq!((r.status, r.reason()), (StatusCode::UNPROCESSABLE_ENTITY, "updates.hash_mismatch"), "{}", r.text);
    let (foreign, foreign_sig) = signed_manifest(&test_key(3), "99.3.0", &[(platform().os, platform().arch, b"x")]);
    let r = t.upload(&[("manifest", &foreign), ("signature", &foreign_sig), ("package", b"x")]).await;
    assert_eq!(r.reason(), "updates.unknown_key", "{}", r.text);
    let (old, old_sig) = release("0.0.1", b"old");
    let r = t.upload(&[("manifest", &old), ("signature", &old_sig), ("package", b"old")]).await;
    assert_eq!((r.status, r.reason()), (StatusCode::CONFLICT, "updates.downgrade"), "{}", r.text);
    let r = t.upload(&[("manifest", &manifest), ("package", b"offline binary")]).await;
    assert_eq!(r.reason(), "updates.upload_incomplete", "{}", r.text);
    let r = t.upload(&[("manifest", &manifest), ("extra", b"?")]).await;
    assert_eq!(r.reason(), "updates.upload_unknown_part", "{}", r.text);
    let big = vec![b'x'; super::signing::MAX_SIGNATURE_BYTES + 1];
    let r = t.upload(&[("signature", &big)]).await;
    assert_eq!(r.reason(), "updates.too_large", "{}", r.text);
    // The refused uploads left the staged release alone and show up in the history.
    let s = t.get().await;
    assert_eq!(s.body["staged"]["version"], "99.2.0");
    let aborted = s.body["history"].as_array().unwrap().iter().filter(|h| h["outcome"] == "aborted").count();
    assert!(aborted >= 3, "{}", s.text);
    // Nothing is left of the refused uploads.
    let left: Vec<String> = std::fs::read_dir(t.state.updates.layout().root())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with("upload-"))
        .collect();
    assert!(left.is_empty(), "{left:?}");
    let actions = t.audit_actions().await;
    assert_eq!(actions[0], "update.uploaded");
    assert!(actions[1..].iter().all(|a| a == "update.upload_refused"), "{actions:?}");
    t.finish().await;
}

#[tokio::test]
async fn without_automatic_mode_apply_and_schedule_are_refused() {
    let t = T::new(None, Mode::Manual("updates.mode_windows_service")).await;
    let (manifest, sig) = release("99.2.0", b"offline binary");
    let r = t.upload(&[("manifest", &manifest), ("signature", &sig), ("package", b"offline binary")]).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.body["mode"]["automatic"], false);
    assert_eq!(r.body["mode"]["reason"], "updates.mode_windows_service");
    let r = t.post("/apply", json!({ "version": "99.2.0" })).await;
    assert_eq!((r.status, r.reason()), (StatusCode::CONFLICT, "updates.manual_only"), "{}", r.text);
    let r = t
        .send(
            Method::PUT,
            "/api/admin/updates/schedule",
            Some(json!({ "version": "99.2.0", "at": NOW + 1000 })),
            Some(&t.admin),
        )
        .await;
    assert_eq!(r.reason(), "updates.manual_only", "{}", r.text);
    assert_eq!(t.exe_content(), "running binary");
    t.finish().await;
}

#[tokio::test]
async fn a_planned_installation_runs_in_its_window() {
    let t = T::new(None, Mode::Automatic).await;
    let (manifest, sig) = release("99.2.0", b"planned binary");
    t.upload(&[("manifest", &manifest), ("signature", &sig), ("package", b"planned binary")]).await;
    let schedule = |at: i64, until: Option<i64>| json!({ "version": "99.2.0", "at": at, "until": until });
    let put = |body: Value| t.send(Method::PUT, "/api/admin/updates/schedule", Some(body), Some(&t.admin));
    let r = put(schedule(NOW - 1, None)).await;
    assert_eq!(r.reason(), "updates.schedule_out_of_range", "{}", r.text);
    let r = put(schedule(NOW + 3_600_000, Some(NOW + 3_600_000 + 7_200_000))).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.body["schedule"]["at"], NOW + 3_600_000);

    t.state.updates.tick(&t.state).await;
    assert_eq!(t.exe_content(), "running binary", "not before its time");
    t.clock.advance_ms(3_600_000);
    t.state.updates.tick(&t.state).await;
    assert_eq!(t.exe_content(), "planned binary");
    assert!(t.state.updates.take_handover().is_some());
    let plan = install::read_plan(t.state.updates.layout()).unwrap();
    assert!(plan.scheduled);
    assert!(t.get().await.body["schedule"].is_null());
    t.finish().await;
}

#[tokio::test]
async fn a_missed_window_does_not_install() {
    let t = T::new(None, Mode::Automatic).await;
    let (manifest, sig) = release("99.2.0", b"planned binary");
    t.upload(&[("manifest", &manifest), ("signature", &sig), ("package", b"planned binary")]).await;
    let body = json!({ "version": "99.2.0", "at": NOW + 1000, "until": NOW + 2000 });
    t.send(Method::PUT, "/api/admin/updates/schedule", Some(body), Some(&t.admin)).await;
    t.clock.advance_ms(10_000);
    t.state.updates.tick(&t.state).await;
    assert_eq!(t.exe_content(), "running binary");
    let s = t.get().await;
    assert_eq!(s.body["job"]["error"]["reason"], "updates.schedule_missed", "{}", s.text);
    t.finish().await;
}

#[tokio::test]
async fn returning_to_a_kept_version_swaps_back_and_restores_only_when_needed() {
    let t = T::new(None, Mode::Automatic).await;
    let layout = t.state.updates.layout().clone();
    let schema = install::schema_version(&t.state.db).await.unwrap();
    let old = t.dir.path().join("old").join(t.exe.file_name().unwrap());
    std::fs::create_dir_all(old.parent().unwrap()).unwrap();
    std::fs::write(&old, "kept binary 0.0.9").unwrap();
    let backup = layout.backups().join("kalzit-0.0.8-1.db");
    std::fs::create_dir_all(layout.backups()).unwrap();
    std::fs::write(&backup, "backup").unwrap();
    install::keep_version(&layout, &old, "0.0.9", schema, None, 1).unwrap();
    install::keep_version(&layout, &old, "0.0.8", schema - 1, Some("kalzit-0.0.8-1.db".into()), 2).unwrap();

    let s = t.get().await;
    let targets = s.body["rollbackTargets"].as_array().unwrap();
    assert_eq!(targets.len(), 2, "{}", s.text);
    let r = t.post("/rollback", json!({ "version": "0.0.8" })).await;
    assert_eq!((r.status, r.reason()), (StatusCode::CONFLICT, "updates.rollback_needs_restore"), "{}", r.text);
    let r = t.post("/rollback", json!({ "version": "1.0.0" })).await;
    assert_eq!(r.reason(), "updates.rollback_unavailable", "{}", r.text);

    let r = t.post("/rollback", json!({ "version": "0.0.9" })).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(t.exe_content(), "kept binary 0.0.9");
    let handover = t.state.updates.take_handover().unwrap();
    assert!(handover.restore.is_none(), "the same schema needs no restore");
    assert_eq!(install::read_plan(&layout).unwrap().kind, install::PlanKind::Rollback);
    assert!(t.audit_actions().await.contains(&"update.rollback_started".to_string()));
    t.finish().await;
}

#[tokio::test]
async fn a_return_across_a_schema_change_restores_the_backup_at_the_handover() {
    let t = T::new(None, Mode::Automatic).await;
    let layout = t.state.updates.layout().clone();
    let schema = install::schema_version(&t.state.db).await.unwrap();
    let old = t.dir.path().join("old").join(t.exe.file_name().unwrap());
    std::fs::create_dir_all(old.parent().unwrap()).unwrap();
    std::fs::write(&old, "kept binary 0.0.8").unwrap();
    let backup = layout.backups().join("kalzit-0.0.8-1.db");
    std::fs::create_dir_all(layout.backups()).unwrap();
    std::fs::write(&backup, "backup").unwrap();
    install::keep_version(&layout, &old, "0.0.8", schema - 1, Some("kalzit-0.0.8-1.db".into()), 2).unwrap();
    let r = t.post("/rollback", json!({ "version": "0.0.8", "restoreDatabase": true })).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let handover = t.state.updates.take_handover().unwrap();
    let (from, to) = handover.restore.unwrap();
    assert_eq!(from, backup);
    assert!(to.ends_with("kalzit.db"));
    t.finish().await;
}

#[tokio::test]
async fn a_manual_backup_is_listed_and_skipping_hides_the_offer() {
    let server = serve_releases(&test_key(1), &[("99.1.0", false, b"new")], &[]).await;
    let t = T::new(Some(server), Mode::Automatic).await;
    let r = t.post("/backups", json!(null)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let backups = r.body["backups"].as_array().unwrap();
    assert_eq!(backups.len(), 1);
    assert_eq!(backups[0]["kind"], "manual");
    assert_eq!(r.body["people"][0]["name"], "Jörg");
    assert!(r.body["preflight"]["backupBytes"].as_u64().unwrap() > 0);

    t.post("/check", json!(null)).await;
    let r = t.post("/skip", json!({ "version": "99.1.0" })).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert!(r.body["available"].is_null());
    assert_eq!(r.body["skipped"], "99.1.0");
    t.finish().await;
}

#[tokio::test]
async fn one_step_at_a_time() {
    let t = T::new(None, Mode::Automatic).await;
    let guard = t.state.updates.work.clone().try_lock_owned().unwrap();
    let r = t.post("/check", json!(null)).await;
    assert_eq!((r.status, r.reason()), (StatusCode::CONFLICT, "updates.busy"), "{}", r.text);
    drop(guard);
    t.finish().await;
}

#[tokio::test]
async fn non_admins_are_refused() {
    let t = T::new(None, Mode::Automatic).await;
    sqlx::query("UPDATE users SET is_server_admin = 0").execute(&t.state.db).await.unwrap();
    let r = t.get().await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    let (manifest, sig) = release("99.2.0", b"x");
    let r = t.upload(&[("manifest", &manifest), ("signature", &sig), ("package", b"x")]).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    assert!(t.state.updates.status(&t.state).await.unwrap().staged.is_none());
    t.finish().await;
}

#[tokio::test]
async fn an_offline_package_file_is_accepted_and_backups_can_be_downloaded() {
    let t = T::new(None, Mode::Automatic).await;
    let (manifest, sig) = release("99.4.0", b"bundled binary");
    let mut bundle = Vec::new();
    super::staging::write_bundle(&mut bundle, &manifest, &sig, b"bundled binary").unwrap();
    let r = t.upload(&[("bundle", &bundle)]).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.body["staged"]["version"], "99.4.0");
    let r = t.upload(&[("bundle", &bundle), ("package", b"x")]).await;
    assert_eq!(r.reason(), "updates.upload_unknown_part", "{}", r.text);
    let r = t.upload(&[("bundle", b"not a package")]).await;
    assert_eq!(r.reason(), "updates.manifest_invalid", "{}", r.text);

    let r = t.post("/backups", json!(null)).await;
    let file = r.body["backups"][0]["file"].as_str().unwrap().to_string();
    let req = Request::builder()
        .uri(format!("/api/admin/updates/backups/{file}"))
        .header(header::HOST, "kalzit.test")
        .header(header::COOKIE, &t.admin)
        .body(Body::empty())
        .unwrap();
    let res = t.app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    assert!(bytes.starts_with(b"SQLite format 3"), "a SQLite file");
    for other in ["..%2Fkalzit.db", "kalzit.db", "missing.db"] {
        let r = t.send(Method::GET, &format!("/api/admin/updates/backups/{other}"), None, Some(&t.admin)).await;
        assert_eq!(r.status, StatusCode::NOT_FOUND, "{other}");
    }
    assert!(t.audit_actions().await.contains(&"update.backup_downloaded".to_string()));
    t.finish().await;
}
