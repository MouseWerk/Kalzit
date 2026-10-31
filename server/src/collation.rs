//! The order of titles and names in lists: the same on SQLite and PostgreSQL, on Windows and Linux,
//! and by the rules of the UI languages instead of the bytes of the text.
//!
//! Kalzit's UI languages are German and English. CLDR defines both alike: the root collation (the
//! Unicode Collation Algorithm with CLDR's data), where "Ö" sorts next to "O" and "ß" like "ss".
//! German's standard order has no tailoring of its own (only the opt-in phone book order does), so
//! one order serves both languages; the tests hold the three collators to the same keys. A UI
//! language with its own tailoring (Swedish puts "Ö" after "Z") needs keys of its own.
//!
//! Comparison ignores case (secondary strength: "apfel" and "Apfel" are equal, "Äpfel" comes after
//! both); lists break ties by id. Lists the database pages through keep the key of each row in a
//! binary column next to the text (`sort_title`, `sort_name`), written with every change of the
//! text and repaired at startup (`refresh`). The database compares only these keys, never the
//! text: its own collation differs between the two databases and between the locales PostgreSQL
//! was set up with, while bytes (`BLOB`, `bytea`) compare alike everywhere. Keys are cut after
//! `MAX_KEY_BYTES`, which keeps them within an index entry; texts that only differ beyond that are
//! equal and ordered by id.

use std::cmp::Ordering;
use std::sync::LazyLock;

use anyhow::{Context, Result};
use icu_collator::options::{CollatorOptions, Strength};
use icu_collator::{Collator, CollatorBorrowed};
use sqlx::AnyPool;

/// Names the order of the stored keys: the collator and its data (pinned exactly in Cargo.toml),
/// the strength and the key layout. A build with another value recomputes every key at startup,
/// so any change of the collator or its data changes this too (a test compares it with
/// Cargo.lock).
pub const VERSION: &str = "icu_collator-2.4.0+data-2.4.0/root/secondary/400";

/// The sort key bytes kept per text. Titles are at most 200 characters; most keys are far shorter.
const MAX_KEY_BYTES: usize = 400;

/// Rows read and written per transaction by `refresh`, so the write lock is never held long.
const BATCH: i64 = 500;

/// The PostgreSQL advisory lock `refresh` holds, so one server at a time recomputes keys.
const REFRESH_LOCK: i64 = 0x4b5a_534f_5254_4b59; // "KZSORTKY"

/// The tables whose rows keep a key: (table, text column, key column).
const KEYED: [(&str, &str, &str); 5] = [
    ("dashboards", "title", "sort_title"),
    ("analyses", "title", "sort_title"),
    ("library_panels", "name", "sort_name"),
    ("playlists", "name", "sort_name"),
    ("service_accounts", "name", "sort_name"),
];

static COLLATOR: LazyLock<CollatorBorrowed<'static>> = LazyLock::new(|| {
    let mut options = CollatorOptions::default();
    options.strength = Some(Strength::Secondary);
    // The compiled data carries the root collation, so this cannot fail.
    Collator::try_new(Default::default(), options).expect("the root collation is compiled in")
});

/// The key of `text`, to store and to compare in the database.
pub fn key(text: &str) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(text.len() * 2);
    let Ok(()) = COLLATOR.write_sort_key_to(text, &mut bytes);
    bytes.truncate(MAX_KEY_BYTES);
    bytes
}

/// The list order of two texts, for lists ordered in memory (ties are the caller's to break).
pub fn compare(a: &str, b: &str) -> Ordering {
    COLLATOR.compare(a, b)
}

/// Brings the stored keys up to date. Runs at startup, after the migrations:
///
/// - When the keys were made by another order (`VERSION`), every row is checked and its key
///   rewritten where it differs.
/// - Otherwise only rows without a key are filled (rows written by an older build or by hand).
///
/// Rows go in batches of `BATCH` per transaction, in id order. A key is written only while the
/// text is still the one it was made from, so a rename meanwhile keeps its own key. On PostgreSQL
/// an advisory lock lets one server at a time do this; a server that waited finds the keys up to
/// date. (The migrations before it take such a lock as well, so the same connection rules apply.)
pub async fn refresh(pool: &AnyPool) -> Result<()> {
    let mut lock = None;
    if pool.connect_options().database_url.scheme() != "sqlite" {
        let mut conn = pool.acquire().await.context("locking the sort key refresh")?;
        // `pg_advisory_lock` returns void, which the `Any` driver cannot read; counting the row works.
        sqlx::query("SELECT COUNT(*) FROM (SELECT pg_advisory_lock($1)) AS locked")
            .bind(REFRESH_LOCK)
            .execute(&mut *conn)
            .await
            .context("locking the sort key refresh")?;
        lock = Some(conn);
    }
    let result = refresh_keys(pool).await;
    if let Some(mut conn) = lock {
        let unlocked =
            sqlx::query("SELECT pg_advisory_unlock($1)").bind(REFRESH_LOCK).execute(&mut *conn).await.is_ok();
        if !unlocked {
            // Closing the connection lets go of the lock.
            let _ = conn.close().await;
        }
    }
    result
}

async fn refresh_keys(pool: &AnyPool) -> Result<()> {
    let stored: Option<(String,)> = sqlx::query_as("SELECT version FROM sort_key_state WHERE id = 1")
        .fetch_optional(pool)
        .await
        .context("reading the sort key version")?;
    let current = stored.as_ref().is_some_and(|(v,)| v == VERSION);
    for (table, text, key_column) in KEYED {
        // Table and column names are the constants above, so nothing else reaches the SQL.
        let only_missing =
            if current { format!(" AND length({key_column}) = 0 AND length({text}) > 0") } else { String::new() };
        let select = format!("SELECT id, {text} FROM {table} WHERE id > $1{only_missing} ORDER BY id LIMIT $2");
        let update =
            format!("UPDATE {table} SET {key_column} = $1 WHERE id = $2 AND {text} = $3 AND {key_column} <> $1");
        let mut after = String::new();
        loop {
            let rows: Vec<(String, String)> = sqlx::query_as(sqlx::AssertSqlSafe(select.as_str()))
                .bind(&after)
                .bind(BATCH)
                .fetch_all(pool)
                .await
                .with_context(|| format!("reading {table} for their sort keys"))?;
            let Some((last, _)) = rows.last() else { break };
            after = last.clone();
            let mut tx = crate::db::begin(pool).await.context("writing sort keys")?;
            for (id, value) in &rows {
                sqlx::query(sqlx::AssertSqlSafe(update.as_str()))
                    .bind(key(value))
                    .bind(id)
                    .bind(value)
                    .execute(&mut *tx)
                    .await
                    .with_context(|| format!("writing the sort keys of {table}"))?;
            }
            crate::db::commit(tx).await.context("writing sort keys")?;
            if (rows.len() as i64) < BATCH {
                break;
            }
        }
    }
    if !current {
        sqlx::query(
            "INSERT INTO sort_key_state (id, version) VALUES (1, $1) \
             ON CONFLICT (id) DO UPDATE SET version = excluded.version",
        )
        .bind(VERSION)
        .execute(pool)
        .await
        .context("storing the sort key version")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sorted(words: &[&str]) -> Vec<String> {
        let mut out: Vec<String> = words.iter().map(|w| w.to_string()).collect();
        out.sort_by_key(|w| key(w));
        out
    }

    #[test]
    fn german_umlauts_sit_next_to_their_letters_and_sharp_s_sorts_like_ss() {
        assert_eq!(
            sorted(&["Zebra", "ß", "Äpfel", "O", "Apfel", "Ö", "Ost", "Öl", "ss", "st"]),
            ["Apfel", "Äpfel", "O", "Ö", "Öl", "Ost", "ss", "ß", "st", "Zebra"]
        );
    }

    #[test]
    fn english_follows_the_unicode_collation() {
        assert_eq!(
            sorted(&["cherry", "Éclair", "banana", "apple pie", "Apple", "eclair", "Delta"]),
            ["Apple", "apple pie", "banana", "cherry", "Delta", "eclair", "Éclair"]
        );
    }

    #[test]
    fn case_is_ignored_and_accents_are_not() {
        assert_eq!(key("Umsatz"), key("UMSATZ"));
        assert_eq!(key("umsatz"), key("Umsatz"));
        assert!(key("Apfel") < key("Äpfel"));
        assert_eq!(compare("Lager", "lager"), Ordering::Equal);
        assert_eq!(compare("Äpfel", "Apfel"), Ordering::Greater);
    }

    #[test]
    fn keys_order_like_the_collator() {
        let words = ["Lager-A", "Lager A", "Lager_A", "LagerA", "lager a2", "Lager.A", "Lager/A", "東京", "Ωmega", ""];
        for a in words {
            for b in words {
                assert_eq!(key(a).cmp(&key(b)), compare(a, b), "{a} / {b}");
            }
        }
        assert!(!key("A").is_empty());
    }

    #[test]
    fn long_texts_keep_a_bounded_key() {
        let long = "Ä".repeat(200);
        assert!(key(&long).len() <= MAX_KEY_BYTES);
        // A cut key is a prefix of the full one, so the order stays monotone.
        assert!(key(&"a".repeat(300)) <= key(&format!("{}b", "a".repeat(300))));
    }

    /// German and English share the root order; a tailoring in either would need keys of its own.
    #[test]
    fn german_and_english_order_like_the_root() {
        let mut options = CollatorOptions::default();
        options.strength = Some(Strength::Secondary);
        let words = ["Äpfel", "Apfel", "Ö", "O", "Zebra", "ß", "ss", "Éclair", "Øre", "Åsa", "Ñandú", "ch", "Ĳssel"];
        for lang in [icu_locale_core::locale!("de"), icu_locale_core::locale!("en")] {
            let c = Collator::try_new(lang.clone().into(), options).unwrap();
            for w in words {
                let (mut a, mut b) = (Vec::new(), Vec::new());
                let Ok(()) = c.write_sort_key_to(w, &mut a);
                let Ok(()) = COLLATOR.write_sort_key_to(w, &mut b);
                assert_eq!(a, b, "{lang}: {w}");
            }
        }
    }

    /// The version of a package in Cargo.lock.
    fn locked(package: &str) -> String {
        let lock = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../Cargo.lock"));
        let entry = format!("name = \"{package}\"\nversion = \"");
        let lock = lock.replace("\r\n", "\n");
        let start = lock.find(&entry).unwrap_or_else(|| panic!("{package} is not in Cargo.lock")) + entry.len();
        lock[start..].split('"').next().unwrap().to_string()
    }

    /// A new collator or new collation data may order differently, so it must come with a new
    /// `VERSION`, which recomputes the stored keys.
    #[test]
    fn the_version_names_the_collator_and_its_data() {
        let expected = format!("icu_collator-{}+data-{}/", locked("icu_collator"), locked("icu_collator_data"));
        assert!(VERSION.starts_with(&expected), "change VERSION to start with {expected}");
    }

    async fn database() -> AnyPool {
        let db = crate::db::connect("sqlite::memory:", 1).await.unwrap();
        sqlx::query("INSERT INTO orgs (id, name, created_at) VALUES ('o', 'O', 0)").execute(&db).await.unwrap();
        db
    }

    async fn insert_dashboard(db: &AnyPool, id: &str, title: &str) {
        sqlx::query(
            "INSERT INTO dashboards (id, org_id, title, search_title, version, created_at, updated_at) \
             VALUES ($1, 'o', $2, $3, 1, 0, 0)",
        )
        .bind(id)
        .bind(title)
        .bind(title.to_lowercase())
        .execute(db)
        .await
        .unwrap();
    }

    async fn keys(db: &AnyPool) -> Vec<(String, Vec<u8>)> {
        sqlx::query_as("SELECT id, sort_title FROM dashboards ORDER BY id").fetch_all(db).await.unwrap()
    }

    /// Rows from before the keys (written without one) get theirs at the next start.
    #[tokio::test]
    async fn rows_without_a_key_are_filled() {
        let db = database().await;
        // More than one batch.
        for i in 0..(BATCH + 3) {
            insert_dashboard(&db, &format!("d{i:04}"), &format!("Ö{i}")).await;
        }
        refresh(&db).await.unwrap();
        let stored = keys(&db).await;
        assert_eq!(stored.len() as i64, BATCH + 3);
        for (id, k) in stored {
            let i: i64 = id[1..].parse().unwrap();
            assert_eq!(k, key(&format!("Ö{i}")), "{id}");
        }
    }

    /// Another order recomputes every key; the same order leaves stored keys alone.
    #[tokio::test]
    async fn a_new_version_recomputes_every_key() {
        let db = database().await;
        insert_dashboard(&db, "a", "Äpfel").await;
        refresh(&db).await.unwrap();
        sqlx::query("UPDATE dashboards SET sort_title = $1").bind(vec![9_u8, 9]).execute(&db).await.unwrap();
        refresh(&db).await.unwrap();
        assert_eq!(keys(&db).await[0].1, vec![9, 9], "the same version keeps the keys");
        sqlx::query("UPDATE sort_key_state SET version = 'older'").execute(&db).await.unwrap();
        refresh(&db).await.unwrap();
        assert_eq!(keys(&db).await[0].1, key("Äpfel"));
        let (version,): (String,) = sqlx::query_as("SELECT version FROM sort_key_state").fetch_one(&db).await.unwrap();
        assert_eq!(version, VERSION);
    }
}
