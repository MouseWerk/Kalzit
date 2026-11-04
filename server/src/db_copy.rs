//! `kalzit db copy`: copies all of Kalzit's own data from its SQLite database into an empty
//! PostgreSQL database, one way, to move an installation to PostgreSQL (several servers,
//! docs/operations/high-availability.md). There is no way back to SQLite and no MySQL/MariaDB.
//!
//! The server must be stopped: the copy holds the SQLite database's instance lock (`db::InstanceLock`),
//! so it refuses to run next to a server, and no server starts on the database while it runs. Both
//! databases must be at this build's schema: the source because this build knows only its own
//! tables, the target because the copy creates it. The target's schema and every row are written in
//! one transaction, so a failed copy leaves the target as empty as it was.
//!
//! Values keep their ids, bytes and numbers. Secrets stay encrypted as they are; the copy first
//! checks that the secrets key of this machine reads them, since the server on PostgreSQL needs
//! the same key. Afterwards the row count of every table is compared with the source.

use std::collections::BTreeSet;
use std::fmt;
use std::path::Path;

use anyhow::{Context, Result, bail};
use futures_util::TryStreamExt;
use sqlx::postgres::{PgConnection, Postgres};
use sqlx::sqlite::{SqliteConnectOptions, SqliteConnection, SqliteRow};
use sqlx::{AssertSqlSafe, Connection, QueryBuilder, Row, TypeInfo, ValueRef};

use crate::config::Config;
use crate::db::redact;
use crate::secrets::{Blob, Keyring};

/// Every table of Kalzit's database, each after the tables it refers to. A migration that adds a
/// table adds it here too; a test holds this list to the migrations.
#[rustfmt::skip]
pub const TABLES: &[&str] = &[
    "acme_challenges", "acme_shared", "audit_events", "branding_logo", "cluster_events", "cluster_instances",
    "cluster_jobs", "cluster_leader", "cluster_versions", "orgs", "plugin_catalog", "plugin_handovers",
    "plugin_host", "plugin_keys", "plugin_packages", "plugin_tombstones", "plugins", "saml_assertions",
    "server_secrets", "server_settings", "setup_lock", "sort_key_state", "sso_providers", "sso_sign_ins",
    "users", "ai_chats", "ai_providers", "ai_usage", "datasources", "email_confirmations",
    "ldap_deactivations", "ldap_sync_runs", "org_members", "org_settings", "password_resets", "playlists",
    "plugin_org_blocks", "resource_grants", "restricted_tombstones", "roles", "scim_groups", "scim_managed",
    "scim_orgs", "scim_users", "second_factor_lockouts", "service_accounts", "sessions",
    "sign_in_challenges", "sso_identities", "sso_managed", "sso_pending_mappings", "sso_provider_secrets",
    "team_contexts", "teams", "usage_dashboard_views", "usage_panel_runs", "usage_source_queries",
    "user_passkeys", "user_preferences", "user_recovery_codes", "user_totp", "ai_chat_messages",
    "ai_datasource_access", "ai_notice_acks", "ai_provider_secrets", "api_tokens", "datasource_health",
    "datasource_secrets", "explore_history", "folders", "invitations", "role_permissions",
    "scim_group_members", "sso_group_mappings", "sso_identity_groups", "team_members", "team_roles",
    "analyses", "dashboards", "library_panels", "analysis_sources", "analysis_uses", "analysis_versions",
    "annotations", "dashboard_pins", "dashboard_stars", "dashboard_tags", "dashboard_versions",
    "dashboard_views", "library_panel_uses", "panel_view_state",
];

/// Tables whose rows refer to rows of the same table (by `id`), with the referring column: their
/// rows are copied parents first.
pub const SELF_REFERENCES: &[(&str, &str)] = &[("folders", "parent_id")];

/// The most bind parameters one INSERT carries (PostgreSQL allows 65535).
const MAX_BINDS: usize = 30_000;

/// What `kalzit db copy` did.
#[derive(Debug)]
pub struct Summary {
    /// The target, with its password masked.
    pub target: String,
    pub schema_version: i64,
    /// Rows per table, the same in source and target.
    pub tables: Vec<(&'static str, i64)>,
    /// Stored secrets read with this machine's key (0: none stored).
    pub secrets_checked: usize,
}

impl fmt::Display for Summary {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let width = self.tables.iter().map(|(t, _)| t.len()).max().unwrap_or(0);
        for (table, rows) in &self.tables {
            writeln!(f, "  {table:<width$}  {rows:>10}")?;
        }
        let total: i64 = self.tables.iter().map(|(_, n)| n).sum();
        writeln!(
            f,
            "copied {total} rows in {} tables to {} (schema {}); every table has the same number of rows as the source",
            self.tables.len(),
            self.target,
            self.schema_version
        )?;
        if self.secrets_checked == 0 {
            write!(f, "no encrypted secrets are stored")
        } else {
            write!(
                f,
                "{} encrypted secrets were copied as they are and read with this machine's secrets key; the server on \
                 PostgreSQL needs the same key",
                self.secrets_checked
            )
        }
    }
}

/// Copies the configured SQLite database into the empty PostgreSQL database at `target_url`.
pub async fn copy(config: &Config, target_url: &str) -> Result<Summary> {
    let source_url = config.database_url();
    let Some(file) = crate::db::sqlite_file(&source_url) else {
        bail!(
            "the configured database ({}) is not a SQLite file; `kalzit db copy` copies from SQLite to PostgreSQL",
            redact(&source_url)
        );
    };
    // A running server holds this lock; holding it keeps a server from starting during the copy.
    let _lock = crate::db::InstanceLock::acquire(&source_url, &config.paths.data_dir)
        .context("stop the Kalzit server before copying its database")?;
    let data_dir = config.paths.data_dir.clone();
    copy_file(&file, target_url, move || Keyring::load(&data_dir)).await
}

/// Copies the SQLite database `source` into the empty PostgreSQL database at `target_url`;
/// `keyring` loads the secrets key when secrets are stored. The caller keeps servers away.
pub async fn copy_file(source: &Path, target_url: &str, keyring: impl FnOnce() -> Result<Keyring>) -> Result<Summary> {
    let target_name = redact(target_url);
    if !(target_url.starts_with("postgres://") || target_url.starts_with("postgresql://")) {
        bail!("the target must be a PostgreSQL URL (postgres://user@host/database), not {target_name}");
    }
    if !source.is_file() {
        bail!("the SQLite database {} does not exist", source.display());
    }
    let options = SqliteConnectOptions::new()
        .filename(source)
        .create_if_missing(false)
        .busy_timeout(crate::db::SQLITE_BUSY_TIMEOUT);
    let mut source_conn = SqliteConnection::connect_with(&options)
        .await
        .with_context(|| format!("opening the SQLite database {}", source.display()))?;
    sqlx::query("PRAGMA query_only = ON").execute(&mut source_conn).await?;
    // One read snapshot for checks, rows and counts.
    let mut src = begin_read(&mut source_conn).await?;

    let latest = crate::db::latest_migration();
    let (version,): (i64,) = sqlx::query_as("SELECT COALESCE(MAX(version), 0) FROM _sqlx_migrations WHERE success")
        .fetch_one(&mut *src)
        .await
        .context("reading the schema version of the SQLite database (is it Kalzit's database?)")?;
    if version != latest {
        bail!(
            "the SQLite database has schema {version}, this Kalzit has schema {latest}; both must be the same. {}",
            if version < latest {
                "Start this Kalzit version once on the SQLite database (it updates the schema), stop it, then copy"
            } else {
                "Copy with the newer Kalzit version that wrote the database"
            }
        );
    }
    let found: BTreeSet<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '_sqlx_migrations'",
    )
    .fetch_all(&mut *src)
    .await?
    .into_iter()
    .collect();
    let known: BTreeSet<String> = TABLES.iter().map(|t| t.to_string()).collect();
    let unknown: Vec<&String> = found.difference(&known).collect();
    let missing: Vec<&String> = known.difference(&found).collect();
    if !unknown.is_empty() || !missing.is_empty() {
        bail!("the SQLite database's tables differ from schema {latest} (unknown: {unknown:?}, missing: {missing:?})");
    }

    let secrets_checked = check_secrets(&mut src, keyring).await?;

    let mut target = PgConnection::connect(target_url).await.with_context(|| format!("connecting to {target_name}"))?;
    let schema: Option<String> = sqlx::query_scalar("SELECT current_schema()::text").fetch_one(&mut target).await?;
    let Some(schema) = schema else {
        bail!("{target_name} has no schema to create the tables in (check the search_path)");
    };
    let (existing,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = current_schema()")
            .fetch_one(&mut target)
            .await?;
    if existing > 0 {
        bail!(
            "the target database is not empty: schema {schema} on {target_name} has {existing} tables. Copy into a new, \
             empty database"
        );
    }

    let mut tx = begin_write(&mut target).await?;
    crate::db::migrator().run(&mut *tx).await.context("creating the schema in the target database")?;
    let (target_version,): (i64,) =
        sqlx::query_as("SELECT COALESCE(MAX(version), 0) FROM _sqlx_migrations WHERE success")
            .fetch_one(&mut *tx)
            .await?;
    if target_version != latest {
        bail!("the target database has schema {target_version} after the migrations, expected {latest}");
    }
    // The migrations insert a few rows of their own; the source has them too.
    for table in TABLES.iter().rev() {
        sqlx::query(AssertSqlSafe(format!("DELETE FROM {}", ident(table)))).execute(&mut *tx).await?;
    }
    for table in TABLES {
        copy_table(&mut src, &mut tx, table).await.with_context(|| format!("copying table {table}"))?;
    }
    reset_sequences(&mut tx).await?;

    let mut tables = Vec::with_capacity(TABLES.len());
    let mut mismatches = Vec::new();
    for table in TABLES {
        let count = format!("SELECT COUNT(*) FROM {}", ident(table));
        let (source_rows,): (i64,) = sqlx::query_as(AssertSqlSafe(count.clone())).fetch_one(&mut *src).await?;
        let (target_rows,): (i64,) = sqlx::query_as(AssertSqlSafe(count)).fetch_one(&mut *tx).await?;
        if source_rows != target_rows {
            mismatches.push(format!("{table}: {source_rows} in SQLite, {target_rows} in PostgreSQL"));
        }
        tables.push((*table, source_rows));
    }
    if !mismatches.is_empty() {
        // Dropping the transaction rolls it back: the target stays empty.
        bail!("the row counts differ, nothing was written to the target: {}", mismatches.join("; "));
    }
    commit(tx).await.context("committing the copy")?;
    drop(src);
    target.close().await.ok();
    source_conn.close().await.ok();
    Ok(Summary { target: target_name, schema_version: latest, tables, secrets_checked })
}

/// A read transaction on the source: its first read fixes the snapshot every later read sees.
#[expect(clippy::disallowed_methods, reason = "the copy's own connections, outside the server's pools")]
async fn begin_read(conn: &mut SqliteConnection) -> Result<sqlx::Transaction<'_, sqlx::Sqlite>> {
    Ok(conn.begin().await?)
}

#[expect(clippy::disallowed_methods, reason = "the copy's own connections, outside the server's pools")]
async fn begin_write(conn: &mut PgConnection) -> Result<sqlx::Transaction<'_, Postgres>> {
    Ok(conn.begin().await?)
}

#[expect(clippy::disallowed_methods, reason = "the copy's own connections, outside the server's pools")]
async fn commit(tx: sqlx::Transaction<'_, Postgres>) -> Result<()> {
    Ok(tx.commit().await?)
}

/// Checks that this machine's secrets key reads the stored secrets, which stay encrypted in the
/// copy: every key id must be loaded, and the secrets of data sources, AI and identity providers
/// and the server must decrypt. Nothing is printed of them. Returns how many were read.
async fn check_secrets(src: &mut SqliteConnection, keyring: impl FnOnce() -> Result<Keyring>) -> Result<usize> {
    let ids: Vec<String> = sqlx::query_scalar(
        "SELECT key_id FROM datasource_secrets UNION SELECT key_id FROM ai_provider_secrets \
         UNION SELECT key_id FROM sso_provider_secrets UNION SELECT key_id FROM server_secrets \
         UNION SELECT key_id FROM user_totp \
         UNION SELECT token_key_id FROM invitations WHERE token_key_id IS NOT NULL \
         UNION SELECT draft_secret_key_id FROM sso_sign_ins WHERE draft_secret_key_id IS NOT NULL",
    )
    .fetch_all(&mut *src)
    .await?;
    if ids.is_empty() {
        return Ok(0);
    }
    let ring = keyring().context("loading the secrets key, which the stored secrets need")?;
    let foreign: Vec<&String> = ids.iter().filter(|id| !ring.knows(id)).collect();
    if !foreign.is_empty() {
        bail!(
            "the stored secrets are encrypted with keys {foreign:?}, but this machine's secrets key is {} (from {}). \
             Run the copy with the key of the server that wrote the database ({} or its data directory); the server on \
             PostgreSQL needs that key too",
            ring.current_id(),
            ring.source(),
            crate::secrets::KEY_ENV
        );
    }
    let rows: Vec<(String, String, String, String, String, String)> = sqlx::query_as(
        "SELECT 'datasource', datasource_id, field, key_id, nonce, ciphertext FROM datasource_secrets \
         UNION ALL SELECT 'ai', provider_id, field, key_id, nonce, ciphertext FROM ai_provider_secrets \
         UNION ALL SELECT 'sso', provider_id, field, key_id, nonce, ciphertext FROM sso_provider_secrets \
         UNION ALL SELECT 'server', owner, field, key_id, nonce, ciphertext FROM server_secrets",
    )
    .fetch_all(&mut *src)
    .await?;
    for (kind, id, field, key_id, nonce, ciphertext) in rows {
        let owner = match kind.as_str() {
            "ai" => crate::ai::store::secret_owner(&id),
            "sso" => crate::sso::store::secret_owner(&id),
            _ => id,
        };
        ring.decrypt(&owner, &field, &Blob { key_id, nonce, ciphertext })
            .with_context(|| format!("the stored secret {field} of {owner} cannot be read with this machine's key"))?;
    }
    let (stored,): (i64,) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM datasource_secrets) + (SELECT COUNT(*) FROM ai_provider_secrets) \
         + (SELECT COUNT(*) FROM sso_provider_secrets) + (SELECT COUNT(*) FROM server_secrets) \
         + (SELECT COUNT(*) FROM user_totp) + (SELECT COUNT(*) FROM invitations WHERE token_key_id IS NOT NULL) \
         + (SELECT COUNT(*) FROM sso_sign_ins WHERE draft_secret_key_id IS NOT NULL)",
    )
    .fetch_one(&mut *src)
    .await?;
    Ok(usize::try_from(stored).unwrap_or(0))
}

/// The PostgreSQL types of Kalzit's columns, and what the copy writes into them.
#[derive(Clone, Copy, Debug)]
enum Kind {
    Int,
    Float,
    Bool,
    Text,
    Bytes,
}

impl Kind {
    fn of(data_type: &str) -> Option<Self> {
        Some(match data_type {
            "bigint" | "integer" | "smallint" => Kind::Int,
            "double precision" | "real" => Kind::Float,
            "boolean" => Kind::Bool,
            "text" | "character varying" | "character" => Kind::Text,
            "bytea" => Kind::Bytes,
            _ => return None,
        })
    }
}

/// One value, typed for its target column (a NULL too: PostgreSQL wants the column's type).
#[derive(Debug, PartialEq)]
enum Value {
    Int(Option<i64>),
    Float(Option<f64>),
    Bool(Option<bool>),
    Text(Option<String>),
    Bytes(Option<Vec<u8>>),
}

/// Column `i` of a SQLite row as a value for a column of `kind`. SQLite keeps a type per value,
/// not per column, so the value's own storage class decides how it is read.
fn read(row: &SqliteRow, i: usize, kind: Kind) -> Result<Value> {
    let raw = row.try_get_raw(i)?;
    if raw.is_null() {
        return Ok(match kind {
            Kind::Int => Value::Int(None),
            Kind::Float => Value::Float(None),
            Kind::Bool => Value::Bool(None),
            Kind::Text => Value::Text(None),
            Kind::Bytes => Value::Bytes(None),
        });
    }
    let class = raw.type_info().name().to_string();
    let int = || row.try_get_unchecked::<i64, _>(i);
    let float = || row.try_get_unchecked::<f64, _>(i);
    let text = || row.try_get_unchecked::<String, _>(i);
    let bytes = || row.try_get_unchecked::<Vec<u8>, _>(i);
    Ok(match (kind, class.as_str()) {
        (Kind::Int, "INTEGER") => Value::Int(Some(int()?)),
        (Kind::Int, "TEXT") => {
            let t = text()?;
            Value::Int(Some(t.trim().parse().with_context(|| format!("the text {t:?} is not a whole number"))?))
        }
        (Kind::Float, "REAL" | "INTEGER") => Value::Float(Some(float()?)),
        (Kind::Bool, "INTEGER") => Value::Bool(Some(int()? != 0)),
        (Kind::Text, "TEXT") => Value::Text(Some(text()?)),
        (Kind::Text, "INTEGER") => Value::Text(Some(int()?.to_string())),
        (Kind::Text, "REAL") => Value::Text(Some(float()?.to_string())),
        (Kind::Text, "BLOB") => {
            Value::Text(Some(String::from_utf8(bytes()?).map_err(|_| anyhow::anyhow!("bytes that are not text"))?))
        }
        (Kind::Bytes, "BLOB") => Value::Bytes(Some(bytes()?)),
        // A BYTEA column has numeric affinity in SQLite: its default '' stays text, and a text
        // that looks like a number would be stored as one.
        (Kind::Bytes, "TEXT") => Value::Bytes(Some(text()?.into_bytes())),
        (Kind::Bytes, "INTEGER") => Value::Bytes(Some(int()?.to_string().into_bytes())),
        (kind, class) => bail!("a {class} value cannot go into a column of kind {kind:?}"),
    })
}

/// Copies every row of `table` in batches; returns how many.
async fn copy_table(src: &mut SqliteConnection, tx: &mut PgConnection, table: &str) -> Result<u64> {
    let columns: Vec<(String, String)> = sqlx::query_as(
        "SELECT column_name::text, data_type::text FROM information_schema.columns \
         WHERE table_schema = current_schema() AND table_name::text = $1 ORDER BY ordinal_position",
    )
    .bind(table)
    .fetch_all(&mut *tx)
    .await?;
    let source_columns: BTreeSet<String> = sqlx::query_scalar("SELECT name FROM pragma_table_info(?)")
        .bind(table)
        .fetch_all(&mut *src)
        .await?
        .into_iter()
        .collect();
    let target_columns: BTreeSet<String> = columns.iter().map(|(c, _)| c.clone()).collect();
    if source_columns != target_columns {
        bail!("the columns differ: SQLite has {source_columns:?}, PostgreSQL has {target_columns:?}");
    }
    let mut kinds = Vec::with_capacity(columns.len());
    for (column, data_type) in &columns {
        kinds
            .push(Kind::of(data_type).with_context(|| {
                format!("column {column} has the type {data_type}, which the copy does not handle")
            })?);
    }
    let list = columns.iter().map(|(c, _)| format!("{}.{}", ident(table), ident(c))).collect::<Vec<_>>().join(", ");
    let select = match SELF_REFERENCES.iter().find(|(t, _)| *t == table) {
        // Parents first; a row whose parent is missing is left out and fails the count check.
        Some((_, parent)) => format!(
            "WITH RECURSIVE tree(id, depth) AS (SELECT id, 0 FROM {t} WHERE {p} IS NULL \
             UNION ALL SELECT x.id, tree.depth + 1 FROM {t} x JOIN tree ON x.{p} = tree.id WHERE tree.depth < 100000) \
             SELECT {list} FROM {t} JOIN tree ON tree.id = {t}.id ORDER BY tree.depth",
            t = ident(table),
            p = ident(parent)
        ),
        None => format!("SELECT {list} FROM {}", ident(table)),
    };
    let insert = format!(
        "INSERT INTO {} ({}) ",
        ident(table),
        columns.iter().map(|(c, _)| ident(c)).collect::<Vec<_>>().join(", ")
    );
    let batch_rows = (MAX_BINDS / columns.len().max(1)).clamp(1, 1000);
    let mut rows = sqlx::query(AssertSqlSafe(select)).fetch(&mut *src);
    let mut batch: Vec<Vec<Value>> = Vec::with_capacity(batch_rows);
    let mut copied = 0;
    while let Some(row) = rows.try_next().await? {
        let mut values = Vec::with_capacity(kinds.len());
        for (i, kind) in kinds.iter().enumerate() {
            values.push(read(&row, i, *kind).with_context(|| format!("column {}", columns[i].0))?);
        }
        batch.push(values);
        if batch.len() == batch_rows {
            copied += insert_batch(tx, &insert, std::mem::take(&mut batch)).await?;
        }
    }
    if !batch.is_empty() {
        copied += insert_batch(tx, &insert, batch).await?;
    }
    Ok(copied)
}

async fn insert_batch(tx: &mut PgConnection, insert: &str, batch: Vec<Vec<Value>>) -> Result<u64> {
    let mut query = QueryBuilder::<Postgres>::new(insert);
    query.push_values(batch, |mut row, values| {
        for value in values {
            match value {
                Value::Int(v) => row.push_bind(v),
                Value::Float(v) => row.push_bind(v),
                Value::Bool(v) => row.push_bind(v),
                Value::Text(v) => row.push_bind(v),
                Value::Bytes(v) => row.push_bind(v),
            };
        }
    });
    Ok(query.build().execute(&mut *tx).await?.rows_affected())
}

/// Sets every sequence that fills a column of the target after the highest copied value, so new
/// rows do not collide with copied ones. Kalzit's ids are texts today; this keeps a later serial
/// column right.
async fn reset_sequences(tx: &mut PgConnection) -> Result<()> {
    let serials: Vec<(String, String, String)> = sqlx::query_as(
        // From the catalog: a function such as pg_get_serial_sequence would also run on the rows of
        // other schemas before the filter, and fail on their names.
        "SELECT t.relname::text, a.attname::text, quote_ident(n.nspname) || '.' || quote_ident(s.relname) \
         FROM pg_class s \
         JOIN pg_namespace n ON n.oid = s.relnamespace \
         JOIN pg_depend d ON d.objid = s.oid AND d.classid = 'pg_class'::regclass \
              AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i') \
         JOIN pg_class t ON t.oid = d.refobjid \
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid \
         WHERE s.relkind = 'S' AND t.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())",
    )
    .fetch_all(&mut *tx)
    .await?;
    for (table, column, sequence) in serials {
        sqlx::query(AssertSqlSafe(format!(
            "SELECT setval($1::regclass, COALESCE((SELECT MAX({c}) FROM {t}), 0) + 1, false)",
            c = ident(&column),
            t = ident(&table)
        )))
        .bind(&sequence)
        .execute(&mut *tx)
        .await
        .with_context(|| format!("resetting the sequence of {table}.{column}"))?;
    }
    Ok(())
}

/// A quoted SQL identifier (the same quoting in SQLite and PostgreSQL).
fn ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A new migration that adds a table must add it to `TABLES`, after the tables it refers to;
    /// a table that refers to itself needs an entry in `SELF_REFERENCES`.
    #[tokio::test]
    async fn tables_follow_the_migrations() {
        let db = crate::db::connect("sqlite::memory:", 1).await.unwrap();
        let found: BTreeSet<String> = sqlx::query_scalar(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' \
             AND name <> '_sqlx_migrations'",
        )
        .fetch_all(&db)
        .await
        .unwrap()
        .into_iter()
        .collect();
        let listed: BTreeSet<String> = TABLES.iter().map(|t| t.to_string()).collect();
        assert_eq!(listed.len(), TABLES.len(), "a table is listed twice");
        let missing: Vec<_> = found.difference(&listed).collect();
        assert!(missing.is_empty(), "tables the copy does not handle; add them to db_copy::TABLES: {missing:?}");
        let gone: Vec<_> = listed.difference(&found).collect();
        assert!(gone.is_empty(), "db_copy::TABLES lists tables the migrations do not create: {gone:?}");
        for (position, table) in TABLES.iter().enumerate() {
            let parents: Vec<(String, String)> =
                sqlx::query_as("SELECT \"table\", \"from\" FROM pragma_foreign_key_list($1)")
                    .bind(*table)
                    .fetch_all(&db)
                    .await
                    .unwrap();
            for (parent, column) in parents {
                if parent == *table {
                    assert!(
                        SELF_REFERENCES.contains(&(*table, column.as_str())),
                        "{table}.{column} refers to {table}: add it to db_copy::SELF_REFERENCES"
                    );
                    continue;
                }
                let at = TABLES.iter().position(|t| *t == parent).unwrap();
                assert!(at < position, "{table} refers to {parent}, which must come before it in db_copy::TABLES");
            }
        }
        db.close().await;
    }

    #[test]
    fn identifiers_are_quoted() {
        assert_eq!(ident("users"), "\"users\"");
        assert_eq!(ident("a\"b"), "\"a\"\"b\"");
    }
}
