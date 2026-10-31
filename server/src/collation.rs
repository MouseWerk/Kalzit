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
//! column next to the text (`sort_title`, `sort_name`), written with every change of the text and
//! recomputed at startup when this build orders differently (`refresh`). The database compares
//! only these keys, never the text: its own collation differs between the two databases and
//! between the locales PostgreSQL was set up with.
//!
//! A key is the collator's sort key bytes written as three decimal digits each. Digits compare the
//! same under every collation PostgreSQL may use and bytewise in SQLite, so `ORDER BY` and the
//! cursor comparison of both databases agree with the order of the bytes. Keys are cut after
//! `MAX_KEY_BYTES`, which keeps them within an index entry; texts that only differ beyond that
//! are equal and ordered by id.

use std::cmp::Ordering;
use std::fmt::Write as _;
use std::sync::LazyLock;

use anyhow::{Context, Result};
use icu_collator::options::{CollatorOptions, Strength};
use icu_collator::{Collator, CollatorBorrowed};
use sqlx::AnyPool;

/// Names the order of the stored keys: the collator's version and the key layout. A build with
/// another value recomputes every key at startup.
pub const VERSION: &str = "icu_collator-2.4/root/secondary/dec3/400";

/// The sort key bytes kept per text (1200 digits). Titles are at most 200 characters; most keys
/// are far shorter.
const MAX_KEY_BYTES: usize = 400;

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
pub fn key(text: &str) -> String {
    let mut bytes = Vec::with_capacity(text.len() * 2);
    let Ok(()) = COLLATOR.write_sort_key_to(text, &mut bytes);
    bytes.truncate(MAX_KEY_BYTES);
    let mut out = String::with_capacity(bytes.len() * 3);
    for b in bytes {
        // Writing to a String does not fail.
        let _ = write!(out, "{b:03}");
    }
    out
}

/// The list order of two texts, for lists ordered in memory (ties are the caller's to break).
pub fn compare(a: &str, b: &str) -> Ordering {
    COLLATOR.compare(a, b)
}

/// Recomputes every stored key when they were made by another order (`VERSION`), or are missing
/// (rows of a new column). Runs at startup, after the migrations; a no-op once the keys match.
pub async fn refresh(pool: &AnyPool) -> Result<()> {
    let stored: Option<(String,)> = sqlx::query_as("SELECT version FROM sort_key_state WHERE id = 1")
        .fetch_optional(pool)
        .await
        .context("reading the sort key version")?;
    if stored.as_ref().is_some_and(|(v,)| v == VERSION) {
        return Ok(());
    }
    let mut tx = crate::db::begin(pool).await.context("recomputing sort keys")?;
    for (table, text, key_column) in KEYED {
        // Table and column names are the constants above, so nothing else reaches the SQL.
        let rows: Vec<(String, String)> =
            sqlx::query_as(sqlx::AssertSqlSafe(format!("SELECT id, {text} FROM {table}")))
                .fetch_all(&mut *tx)
                .await
                .with_context(|| format!("reading {table} for their sort keys"))?;
        let update = format!("UPDATE {table} SET {key_column} = $1 WHERE id = $2");
        for (id, value) in rows {
            sqlx::query(sqlx::AssertSqlSafe(update.as_str()))
                .bind(key(&value))
                .bind(&id)
                .execute(&mut *tx)
                .await
                .with_context(|| format!("writing the sort keys of {table}"))?;
        }
    }
    sqlx::query(
        "INSERT INTO sort_key_state (id, version) VALUES (1, $1) \
         ON CONFLICT (id) DO UPDATE SET version = excluded.version",
    )
    .bind(VERSION)
    .execute(&mut *tx)
    .await
    .context("storing the sort key version")?;
    crate::db::commit(tx).await.context("recomputing sort keys")?;
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
    fn keys_order_like_the_collator_and_hold_digits_only() {
        let words = ["Lager-A", "Lager A", "Lager_A", "LagerA", "lager a2", "Lager.A", "Lager/A", "東京", "Ωmega", ""];
        for a in words {
            assert!(key(a).bytes().all(|b| b.is_ascii_digit()), "{a}");
            for b in words {
                assert_eq!(key(a).cmp(&key(b)), compare(a, b), "{a} / {b}");
            }
        }
    }

    #[test]
    fn long_texts_keep_a_bounded_key() {
        let long = "Ä".repeat(200);
        assert!(key(&long).len() <= MAX_KEY_BYTES * 3);
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
}
