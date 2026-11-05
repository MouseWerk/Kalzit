//! `kalzit db copy` (`kalzit::db_copy`): a SQLite database with every kind of column value copied
//! into a throwaway schema on the PostgreSQL test database (`KALZIT_TEST_POSTGRES_URL`, CI job
//! `postgres`), and the refusals that need no PostgreSQL.

use kalzit::config::sqlite_url;
use kalzit::db_copy::{TABLES, copy_file};
use kalzit::secrets::{Blob, Keyring, SecretKey};
use sqlx::Row;

mod common;

const ORG: &str = "org-copy";
const KEY: [u8; 32] = [7; 32];

fn keyring(raw: &[u8; 32]) -> Keyring {
    Keyring::from_key(SecretKey::from_bytes(raw).unwrap())
}

/// A migrated SQLite database in `dir` with a value of every column kind: texts with umlauts and
/// quotes, whole numbers up to the ends of BIGINT, booleans as 0 and 1, NULLs, bytes with zero
/// and 0xFF in them and the default empty bytes, a folder stored before its parent, and an
/// encrypted data source password.
async fn source(dir: &std::path::Path) -> std::path::PathBuf {
    let file = dir.join("kalzit.db");
    let db = kalzit::db::connect(&sqlite_url(&file), 1).await.unwrap();
    sqlx::query("INSERT INTO orgs (id, name, created_at) VALUES ($1, 'Kälte \"GmbH\"', $2)")
        .bind(ORG)
        .bind(i64::MIN)
        .execute(&db)
        .await
        .unwrap();
    // `c` is stored before its parent `b`: the copy must still write `b` first.
    for (id, parent) in [("a", None), ("c", Some("a")), ("b", None)] {
        sqlx::query(
            "INSERT INTO folders (id, org_id, parent_id, name, restricted, version, created_at, updated_at) \
             VALUES ($1, $2, $3, $1, 1, 1, 0, 0)",
        )
        .bind(id)
        .bind(ORG)
        .bind(parent)
        .execute(&db)
        .await
        .unwrap();
    }
    sqlx::query("UPDATE folders SET parent_id = 'b' WHERE id = 'c'").execute(&db).await.unwrap();
    sqlx::query(
        "INSERT INTO dashboards (id, org_id, folder_id, title, search_title, version, created_by, created_at, \
         updated_by, updated_at, deleted_at, trash_batch, ever_restricted, tags, owner_team_id, team_only, sort_title) \
         VALUES ('d1', $1, 'c', 'Übersicht ''Q3''', 'ubersicht q3', 7, NULL, 1700000000000, NULL, -1, $2, NULL, 1, \
         '[\"ä\",\"b\"]', NULL, 0, $3)",
    )
    .bind(ORG)
    .bind(i64::MAX)
    .bind(vec![0u8, 1, 0xFF, 0x80, 0])
    .execute(&db)
    .await
    .unwrap();
    // The default sort key: SQLite keeps '' as text in the BYTEA column.
    sqlx::query(
        "INSERT INTO dashboards (id, org_id, title, search_title, version, created_at, updated_at, tags) \
         VALUES ('d2', $1, 'leer', 'leer', 1, 0, 0, '[]')",
    )
    .bind(ORG)
    .execute(&db)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO datasources (id, org_id, name, kind, settings, created_at, updated_at) \
         VALUES ('ds1', $1, 'Lager', 'postgres', '{}', 0, 0)",
    )
    .bind(ORG)
    .execute(&db)
    .await
    .unwrap();
    let blob = keyring(&KEY).encrypt("ds1", "password", "geheim");
    sqlx::query(
        "INSERT INTO datasource_secrets (datasource_id, field, key_id, nonce, ciphertext) \
         VALUES ('ds1', 'password', $1, $2, $3)",
    )
    .bind(&blob.key_id)
    .bind(&blob.nonce)
    .bind(&blob.ciphertext)
    .execute(&db)
    .await
    .unwrap();
    // An authenticator app key, bound to its user (`auth::second_factor`).
    sqlx::query("INSERT INTO users (id, email, name, created_at) VALUES ('u1', 'u1@example.test', 'U', 0)")
        .execute(&db)
        .await
        .unwrap();
    let totp = keyring(&KEY).encrypt("user:u1", "totp", "JBSWY3DPEHPK3PXP");
    sqlx::query(
        "INSERT INTO user_totp (user_id, key_id, nonce, ciphertext, last_step, created_at) \
         VALUES ('u1', $1, $2, $3, 0, 0)",
    )
    .bind(&totp.key_id)
    .bind(&totp.nonce)
    .bind(&totp.ciphertext)
    .execute(&db)
    .await
    .unwrap();
    db.close().await;
    file
}

#[tokio::test]
async fn copies_sqlite_into_postgres() {
    let Some(base) = common::postgres_url("SQLite to PostgreSQL copy") else { return };
    let dir = common::private_tempdir();
    let file = source(dir.path()).await;
    let target = common::postgres_schema(&base).await;

    // Another key does not read the stored secret: refused before the target is touched.
    let err = copy_file(&file, &target.url, || Ok(keyring(&[9; 32]))).await.unwrap_err();
    assert!(format!("{err:#}").contains("encrypted with keys"), "{err:#}");

    let summary = copy_file(&file, &target.url, || Ok(keyring(&KEY))).await.unwrap();
    assert_eq!(summary.tables.len(), TABLES.len());
    assert_eq!(summary.secrets_checked, 2);
    let rows = |t: &str| summary.tables.iter().find(|(name, _)| *name == t).unwrap().1;
    assert_eq!((rows("orgs"), rows("folders"), rows("dashboards"), rows("datasource_secrets")), (1, 3, 2, 1));
    let text = summary.to_string();
    assert!(text.contains("every table has the same number of rows"), "{text}");

    // The copy as written, before a server opens it (a server fills empty sort keys at start).
    sqlx::any::install_default_drivers();
    let pg = sqlx::AnyPool::connect(&target.url).await.unwrap();
    let (name, created): (String, i64) =
        sqlx::query_as("SELECT name, created_at FROM orgs WHERE id = $1").bind(ORG).fetch_one(&pg).await.unwrap();
    assert_eq!((name.as_str(), created), ("Kälte \"GmbH\"", i64::MIN));
    let folders: Vec<(String, Option<String>)> =
        sqlx::query_as("SELECT id, parent_id FROM folders ORDER BY id").fetch_all(&pg).await.unwrap();
    assert_eq!(folders, [("a".into(), None), ("b".into(), None), ("c".into(), Some("b".into()))]);
    let row = sqlx::query("SELECT * FROM dashboards WHERE id = 'd1'").fetch_one(&pg).await.unwrap();
    assert_eq!(row.get::<String, _>("title"), "Übersicht 'Q3'");
    assert_eq!(row.get::<i64, _>("deleted_at"), i64::MAX);
    assert_eq!(row.get::<i64, _>("updated_at"), -1);
    assert_eq!(row.get::<i64, _>("created_at"), 1_700_000_000_000);
    assert_eq!((row.get::<i64, _>("ever_restricted"), row.get::<i64, _>("team_only")), (1, 0));
    assert_eq!(row.get::<Option<String>, _>("created_by"), None);
    assert_eq!(row.get::<String, _>("tags"), "[\"ä\",\"b\"]");
    let sort: Vec<u8> =
        sqlx::query_scalar("SELECT sort_title FROM dashboards WHERE id = 'd1'").fetch_one(&pg).await.unwrap();
    assert_eq!(sort, [0u8, 1, 0xFF, 0x80, 0]);
    let empty: Vec<u8> =
        sqlx::query_scalar("SELECT sort_title FROM dashboards WHERE id = 'd2'").fetch_one(&pg).await.unwrap();
    assert!(empty.is_empty());
    let (key_id, nonce, ciphertext): (String, String, String) =
        sqlx::query_as("SELECT key_id, nonce, ciphertext FROM datasource_secrets WHERE datasource_id = 'ds1'")
            .fetch_one(&pg)
            .await
            .unwrap();
    let plain = keyring(&KEY).decrypt("ds1", "password", &Blob { key_id, nonce, ciphertext }).unwrap();
    assert_eq!(plain.as_str(), "geheim");
    pg.close().await;

    // The server opens the copy as it is: same schema, nothing to migrate.
    let pg = kalzit::db::connect(&target.url, 2).await.unwrap();
    let (dashboards,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM dashboards").fetch_one(&pg).await.unwrap();
    assert_eq!(dashboards, 2);
    pg.close().await;

    // A target that is not empty is refused.
    let err = copy_file(&file, &target.url, || Ok(keyring(&KEY))).await.unwrap_err();
    assert!(format!("{err:#}").contains("not empty"), "{err:#}");
    target.drop_now().await;
    common::remove_dir(dir);
}

#[tokio::test]
async fn refuses_a_target_that_is_not_postgres() {
    let dir = common::private_tempdir();
    let file = source(dir.path()).await;
    let err = copy_file(&file, "mysql://kalzit:pw-secret@localhost/kalzit", || Ok(keyring(&KEY))).await.unwrap_err();
    let text = format!("{err:#}");
    assert!(text.contains("PostgreSQL URL"), "{text}");
    assert!(!text.contains("pw-secret"), "the password must not be shown: {text}");
    common::remove_dir(dir);
}

/// Every stored secret is decrypted before the target is reached, the authenticator app keys
/// included: one bound to another user fails although its key is known.
#[tokio::test]
async fn refuses_a_secret_that_does_not_decrypt() {
    let dir = common::private_tempdir();
    let file = source(dir.path()).await;
    let db = kalzit::db::connect(&sqlite_url(&file), 1).await.unwrap();
    let moved = keyring(&KEY).encrypt("user:someone-else", "totp", "JBSWY3DPEHPK3PXP");
    sqlx::query("UPDATE user_totp SET nonce = $1, ciphertext = $2 WHERE user_id = 'u1'")
        .bind(&moved.nonce)
        .bind(&moved.ciphertext)
        .execute(&db)
        .await
        .unwrap();
    db.close().await;
    // Nothing listens on port 1: the copy fails before it would connect.
    let err = copy_file(&file, "postgres://kalzit@127.0.0.1:1/kalzit", || Ok(keyring(&KEY))).await.unwrap_err();
    let text = format!("{err:#}");
    assert!(text.contains("totp of user:u1 cannot be read"), "{text}");
    common::remove_dir(dir);
}

#[tokio::test]
async fn refuses_a_missing_source() {
    let dir = common::private_tempdir();
    let err = copy_file(&dir.path().join("none.db"), "postgres://kalzit@localhost/kalzit", || Ok(keyring(&KEY)))
        .await
        .unwrap_err();
    assert!(format!("{err:#}").contains("does not exist"), "{err:#}");
    assert!(!dir.path().join("none.db").exists(), "the copy must not create the source");
    common::remove_dir(dir);
}
