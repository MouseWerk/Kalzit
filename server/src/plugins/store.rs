//! The plugin host's tables (migrations 0020 and 0021): installed plugins, what removed ones
//! leave behind, trusted publisher keys, key hand-overs, organization blocks and the host's
//! switches.

use sqlx::AnyConnection;

use crate::error::ApiResult;

/// An installed plugin as stored.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PluginRow {
    pub id: String,
    pub name: String,
    pub version: String,
    pub kind: String,
    /// The exact text of `kalzit-plugin.toml`.
    pub manifest: String,
    /// `kalzit`, `publisher` or `unsigned`.
    pub signer: String,
    /// The signing key, 32 bytes in lowercase hex.
    pub public_key: Option<String>,
    /// The package directory below `<data_dir>/plugins/packages`.
    pub dir: String,
    pub approved: bool,
    pub enabled: bool,
    pub pending: Option<Pending>,
    pub installed_at: i64,
    pub updated_at: i64,
}

/// An update that waits for the approval of the permissions it adds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pending {
    pub version: String,
    pub manifest: String,
    pub signer: String,
    pub public_key: Option<String>,
    pub dir: String,
}

#[derive(sqlx::FromRow)]
struct Row {
    id: String,
    name: String,
    version: String,
    kind: String,
    manifest: String,
    signer: String,
    public_key: Option<String>,
    dir: String,
    approved: i64,
    enabled: i64,
    pending_version: Option<String>,
    pending_manifest: Option<String>,
    pending_signer: Option<String>,
    pending_public_key: Option<String>,
    pending_dir: Option<String>,
    installed_at: i64,
    updated_at: i64,
}

const SELECT: &str = "SELECT id, name, version, kind, manifest, signer, public_key, dir, approved, enabled, \
     pending_version, pending_manifest, pending_signer, pending_public_key, pending_dir, installed_at, updated_at \
     FROM plugins";

fn from_row(r: Row) -> PluginRow {
    let pending = match (r.pending_version, r.pending_manifest, r.pending_signer, r.pending_dir) {
        (Some(version), Some(manifest), Some(signer), Some(dir)) => {
            Some(Pending { version, manifest, signer, public_key: r.pending_public_key, dir })
        }
        _ => None,
    };
    PluginRow {
        id: r.id,
        name: r.name,
        version: r.version,
        kind: r.kind,
        manifest: r.manifest,
        signer: r.signer,
        public_key: r.public_key,
        dir: r.dir,
        approved: r.approved != 0,
        enabled: r.enabled != 0,
        pending,
        installed_at: r.installed_at,
        updated_at: r.updated_at,
    }
}

pub async fn all<'e, E: sqlx::Executor<'e, Database = sqlx::Any>>(db: E) -> ApiResult<Vec<PluginRow>> {
    let rows: Vec<Row> = sqlx::query_as(sqlx::AssertSqlSafe(format!("{SELECT} ORDER BY id"))).fetch_all(db).await?;
    Ok(rows.into_iter().map(from_row).collect())
}

pub async fn get<'e, E: sqlx::Executor<'e, Database = sqlx::Any>>(db: E, id: &str) -> ApiResult<Option<PluginRow>> {
    let row: Option<Row> =
        sqlx::query_as(sqlx::AssertSqlSafe(format!("{SELECT} WHERE id = $1"))).bind(id).fetch_optional(db).await?;
    Ok(row.map(from_row))
}

/// Inserts a new plugin or replaces every field of an installed one.
pub async fn put(conn: &mut AnyConnection, p: &PluginRow, by: &str) -> ApiResult<()> {
    let pending = p.pending.as_ref();
    sqlx::query(
        "INSERT INTO plugins (id, name, version, kind, manifest, signer, public_key, dir, approved, enabled, \
         pending_version, pending_manifest, pending_signer, pending_public_key, pending_dir, installed_at, \
         updated_at, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, \
         $17, $18) ON CONFLICT (id) DO UPDATE SET name = excluded.name, version = excluded.version, \
         kind = excluded.kind, manifest = excluded.manifest, signer = excluded.signer, \
         public_key = excluded.public_key, dir = excluded.dir, approved = excluded.approved, \
         enabled = excluded.enabled, pending_version = excluded.pending_version, \
         pending_manifest = excluded.pending_manifest, pending_signer = excluded.pending_signer, \
         pending_public_key = excluded.pending_public_key, pending_dir = excluded.pending_dir, \
         updated_at = excluded.updated_at, updated_by = excluded.updated_by",
    )
    .bind(&p.id)
    .bind(&p.name)
    .bind(&p.version)
    .bind(&p.kind)
    .bind(&p.manifest)
    .bind(&p.signer)
    .bind(&p.public_key)
    .bind(&p.dir)
    .bind(i64::from(p.approved))
    .bind(i64::from(p.enabled))
    .bind(pending.map(|x| x.version.clone()))
    .bind(pending.map(|x| x.manifest.clone()))
    .bind(pending.map(|x| x.signer.clone()))
    .bind(pending.and_then(|x| x.public_key.clone()))
    .bind(pending.map(|x| x.dir.clone()))
    .bind(p.installed_at)
    .bind(p.updated_at)
    .bind(by)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Removes an installed plugin and keeps its tombstone; its hand-overs stay with the id.
pub async fn delete(conn: &mut AnyConnection, p: &PluginRow, by: &str, at: i64) -> ApiResult<()> {
    sqlx::query("DELETE FROM plugins WHERE id = $1").bind(&p.id).execute(&mut *conn).await?;
    sqlx::query(
        "INSERT INTO plugin_tombstones (plugin_id, version, signer, public_key, removed_at, removed_by)          VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (plugin_id) DO UPDATE SET version = excluded.version,          signer = excluded.signer, public_key = excluded.public_key, removed_at = excluded.removed_at,          removed_by = excluded.removed_by",
    )
    .bind(&p.id)
    .bind(&p.version)
    .bind(&p.signer)
    .bind(&p.public_key)
    .bind(at)
    .bind(by)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// What a removed plugin left behind: the last installed version and the key that signed it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tombstone {
    pub version: String,
    pub signer: String,
    /// 32 bytes in lowercase hex; `None` when it was unsigned.
    pub public_key: Option<String>,
}

pub async fn tombstone<'e, E: sqlx::Executor<'e, Database = sqlx::Any>>(
    db: E,
    id: &str,
) -> ApiResult<Option<Tombstone>> {
    let row: Option<(String, String, Option<String>)> =
        sqlx::query_as("SELECT version, signer, public_key FROM plugin_tombstones WHERE plugin_id = $1")
            .bind(id)
            .fetch_optional(db)
            .await?;
    Ok(row.map(|(version, signer, public_key)| Tombstone { version, signer, public_key }))
}

pub async fn delete_tombstone(conn: &mut AnyConnection, id: &str) -> ApiResult<()> {
    sqlx::query("DELETE FROM plugin_tombstones WHERE plugin_id = $1").bind(id).execute(&mut *conn).await?;
    Ok(())
}

/// Forgets the hand-overs of an id, when another publisher takes it over.
pub async fn delete_handovers(conn: &mut AnyConnection, id: &str) -> ApiResult<()> {
    sqlx::query("DELETE FROM plugin_handovers WHERE plugin_id = $1").bind(id).execute(&mut *conn).await?;
    Ok(())
}

/// The data sources of a kind, in every organization and in the trash too (their secrets stay
/// until they are purged).
pub async fn datasources_of_kind<'e, E: sqlx::Executor<'e, Database = sqlx::Any>>(
    db: E,
    kind: &str,
) -> ApiResult<Vec<String>> {
    let rows: Vec<(String,)> =
        sqlx::query_as("SELECT id FROM datasources WHERE kind = $1 ORDER BY id").bind(kind).fetch_all(db).await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

/// Removes the stored secrets of every data source of a kind; answers how many were removed.
pub async fn clear_secrets_of_kind(conn: &mut AnyConnection, kind: &str) -> ApiResult<u64> {
    let n = sqlx::query(
        "DELETE FROM datasource_secrets WHERE datasource_id IN (SELECT id FROM datasources WHERE kind = $1)",
    )
    .bind(kind)
    .execute(&mut *conn)
    .await?;
    Ok(n.rows_affected())
}

/// A publisher key an administrator trusts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeyRow {
    pub key_id: String,
    /// 32 bytes in lowercase hex.
    pub public_key: String,
    pub name: String,
    pub added_at: i64,
}

pub async fn keys<'e, E: sqlx::Executor<'e, Database = sqlx::Any>>(db: E) -> ApiResult<Vec<KeyRow>> {
    let mut rows: Vec<(String, String, String, i64)> =
        sqlx::query_as("SELECT key_id, public_key, name, added_at FROM plugin_keys").fetch_all(db).await?;
    rows.sort_by(|a, b| crate::collation::compare(&a.2, &b.2).then_with(|| a.0.cmp(&b.0)));
    Ok(rows
        .into_iter()
        .map(|(key_id, public_key, name, added_at)| KeyRow { key_id, public_key, name, added_at })
        .collect())
}

pub async fn add_key(conn: &mut AnyConnection, key: &KeyRow, by: &str) -> ApiResult<()> {
    sqlx::query("INSERT INTO plugin_keys (key_id, public_key, name, added_at, added_by) VALUES ($1, $2, $3, $4, $5)")
        .bind(&key.key_id)
        .bind(&key.public_key)
        .bind(&key.name)
        .bind(key.added_at)
        .bind(by)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

pub async fn remove_key(conn: &mut AnyConnection, key_id: &str) -> ApiResult<bool> {
    let n = sqlx::query("DELETE FROM plugin_keys WHERE key_id = $1").bind(key_id).execute(&mut *conn).await?;
    Ok(n.rows_affected() > 0)
}

/// A verified hand-over kept with a plugin id.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HandOverRow {
    pub from_key: String,
    pub to_key: String,
    pub from_version: String,
    pub signature: String,
}

pub async fn handovers<'e, E: sqlx::Executor<'e, Database = sqlx::Any>>(
    db: E,
    plugin_id: &str,
) -> ApiResult<Vec<HandOverRow>> {
    let rows: Vec<(String, String, String, String)> = sqlx::query_as(
        "SELECT from_key, to_key, from_version, signature FROM plugin_handovers WHERE plugin_id = $1 \
         ORDER BY added_at, from_key, to_key",
    )
    .bind(plugin_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(from_key, to_key, from_version, signature)| HandOverRow { from_key, to_key, from_version, signature })
        .collect())
}

pub async fn add_handover(conn: &mut AnyConnection, plugin_id: &str, h: &HandOverRow, at: i64) -> ApiResult<()> {
    sqlx::query(
        "INSERT INTO plugin_handovers (plugin_id, from_key, to_key, from_version, signature, added_at) \
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (plugin_id, from_key, to_key, from_version) DO NOTHING",
    )
    .bind(plugin_id)
    .bind(&h.from_key)
    .bind(&h.to_key)
    .bind(&h.from_version)
    .bind(&h.signature)
    .bind(at)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Every (organization, plugin) block.
pub async fn blocks<'e, E: sqlx::Executor<'e, Database = sqlx::Any>>(db: E) -> ApiResult<Vec<(String, String)>> {
    Ok(sqlx::query_as("SELECT org_id, plugin_id FROM plugin_org_blocks").fetch_all(db).await?)
}

/// Blocks or unblocks; true when something changed.
pub async fn set_block(
    conn: &mut AnyConnection,
    org_id: &str,
    plugin_id: &str,
    blocked: bool,
    by: &str,
    at: i64,
) -> ApiResult<bool> {
    let n = if blocked {
        sqlx::query(
            "INSERT INTO plugin_org_blocks (org_id, plugin_id, blocked_at, blocked_by) VALUES ($1, $2, $3, $4) \
             ON CONFLICT (org_id, plugin_id) DO NOTHING",
        )
        .bind(org_id)
        .bind(plugin_id)
        .bind(at)
        .bind(by)
        .execute(&mut *conn)
        .await?
    } else {
        sqlx::query("DELETE FROM plugin_org_blocks WHERE org_id = $1 AND plugin_id = $2")
            .bind(org_id)
            .bind(plugin_id)
            .execute(&mut *conn)
            .await?
    };
    Ok(n.rows_affected() > 0)
}

/// The host's switches.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct HostSwitches {
    pub allow_unsigned: bool,
    pub allow_without_landlock: bool,
}

pub async fn switches<'e, E: sqlx::Executor<'e, Database = sqlx::Any>>(db: E) -> ApiResult<HostSwitches> {
    let row: Option<(i64, i64)> =
        sqlx::query_as("SELECT allow_unsigned, allow_without_landlock FROM plugin_host WHERE id = 'server'")
            .fetch_optional(db)
            .await?;
    Ok(row.map_or_else(HostSwitches::default, |(a, b)| HostSwitches {
        allow_unsigned: a != 0,
        allow_without_landlock: b != 0,
    }))
}

pub async fn set_switches(conn: &mut AnyConnection, s: HostSwitches, by: &str, at: i64) -> ApiResult<()> {
    sqlx::query(
        "INSERT INTO plugin_host (id, allow_unsigned, allow_without_landlock, updated_at, updated_by) \
         VALUES ('server', $1, $2, $3, $4) ON CONFLICT (id) DO UPDATE SET allow_unsigned = excluded.allow_unsigned, \
         allow_without_landlock = excluded.allow_without_landlock, updated_at = excluded.updated_at, \
         updated_by = excluded.updated_by",
    )
    .bind(i64::from(s.allow_unsigned))
    .bind(i64::from(s.allow_without_landlock))
    .bind(at)
    .bind(by)
    .execute(&mut *conn)
    .await?;
    Ok(())
}
