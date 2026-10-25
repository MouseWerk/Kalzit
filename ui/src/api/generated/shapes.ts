// Generated from server/src/shapes.rs by `KALZIT_UPDATE_GENERATED=1 cargo test`. Do not edit.

export type ErrorCode = "validation" | "unauthenticated" | "forbidden" | "not_found" | "method_not_allowed" | "payload_too_large" | "conflict" | "version_conflict" | "rate_limited" | "cross_origin" | "invalid_credentials" | "setup_done" | "invalid_setup_token" | "datasource_error" | "datasource_target_blocked" | "query_timeout" | "query_rejected" | "busy" | "internal";

export type Permission = "dashboards:read" | "dashboards:write" | "dashboards:delete" | "dashboards:share" | "folders:read" | "folders:write" | "folders:permissions" | "datasources:query" | "datasources:read" | "datasources:write" | "datasources:permissions" | "analyses:read" | "analyses:write" | "data:export" | "annotations:write" | "teams:read" | "teams:write" | "teams:members" | "users:read" | "users:invite" | "users:write" | "roles:read" | "roles:write" | "serviceaccounts:write" | "audit:read" | "plugins:configure" | "settings:read" | "settings:write" | "org:write" | "org:delete";

export type SettingKey = "datasources.sqlite_dirs" | "datasources.file_dirs" | "datasources.allowed_targets" | "datasources.query_timeout_secs" | "datasources.max_rows" | "datasources.max_response_bytes" | "datasources.max_parallel_queries" | "datasources.max_inflight_bytes" | "audit.retention_days" | "appearance.default_language" | "appearance.default_theme" | "sessions.lifetime_hours" | "sessions.idle_timeout_hours" | "dashboards.version_retention" | "updates.channel" | "updates.check_daily" | "updates.window" | "updates.keep_versions" | "updates.health_timeout_secs" | "dashboards.default_time_range" | "dashboards.new_in_team_space" | "appearance.product_name" | "appearance.accent" | "appearance.density" | "appearance.font_size" | "appearance.start_page" | "appearance.time_zone" | "appearance.week_start" | "signin.welcome" | "signin.notice" | "server.http_addr" | "server.https_addr" | "server.public_url" | "server.redirect_http_to_https" | "tls.cert_file" | "tls.min_version" | "tls.reload_interval_secs" | "security.trusted_proxies" | "security.hsts" | "security.hsts_max_age_secs" | "security.login_max_failures" | "security.login_window_secs" | "log.level" | "log.format";

export type Shape = "frame" | "documents" | "graph";

export type QueryResult = { "shape": "frame", frame: Frame, } | { "shape": "documents", documents: DocumentSet, } | { "shape": "graph", graph: GraphSet, };

export type Frame = { fields: Array<Field>, meta?: FrameMeta, };

export type FrameMeta = { 
/**
 * The statement as sent to the database after macros were expanded (shown in the inspector).
 */
executedQuery?: string, rowsTruncated: boolean, notices: Array<Notice>, };

export type Notice = { severity: NoticeSeverity, 
/**
 * A stable code the UI translates (see docs/api/datasources.md).
 */
code: string, 
/**
 * Values the code's text needs (`{column}`).
 */
params?: { [key in string]: string }, 
/**
 * English fallback.
 */
text: string, };

export type NoticeSeverity = "info" | "warning";

export type FieldType = "time" | "number" | "int64" | "string" | "bool" | "json";

export type Field = { name: string, type: FieldType, unit?: string, 
/**
 * One value per row; `null` where the row has no value.
 */
values: unknown[], 
/**
 * Series labels, e.g. from Prometheus.
 */
labels?: { [key in string]: string }, };

export type DocumentSet = { 
/**
 * Documents with typed values (see `typed`) where JSON has no type for them, each in the
 * field order the database stored.
 */
documents: unknown[], 
/**
 * Sampled from the result: every field path with its types and how many documents have it.
 */
schema: Array<FieldSchema>, nextCursor?: string, truncated?: Truncated, 
/**
 * Why the set was cut, values that are not shown, ... (codes as for frames).
 */
notices: Array<Notice>, 
/**
 * The query as sent, after macros and variables were bound (shown in the inspector).
 */
executedQuery?: string, };

export type FieldSchema = { 
/**
 * Dotted path; array elements as `[]` (`items[].price`).
 */
path: string, 
/**
 * Share of documents that contain the path, 0 to 1.
 */
coverage: number, types: Array<TypeShare>, };

export type TypeShare = { name: string, 
/**
 * Share of the documents with this path where the value has this type, 0 to 1.
 */
share: number, };

export type Truncated = { limit: number, 
/**
 * Which limit cut the result (a notice code such as `graph.node_limit`), when known.
 */
reason?: string, };

export type GraphSet = { nodes: Array<Node>, edges: Array<Edge>, 
/**
 * Paths stay paths when the query returned them, instead of a loose set of edges.
 */
paths?: Array<GraphPath>, schema: GraphSchema, truncated?: Truncated, 
/**
 * What the source said about the result, such as columns that are not part of the graph.
 */
notices?: Array<Notice>, };

export type Node = { id: string, labels: Array<string>, properties: Record<string, unknown>, };

export type Edge = { id: string, type: string, from: string, to: string, properties: Record<string, unknown>, };

export type GraphPath = { nodes: Array<string>, edges: Array<string>, };

export type GraphSchema = { labels: Array<string>, edgeTypes: Array<string>, 
/**
 * Property keys seen per label.
 */
propertyKeys: { [key in string]: Array<string> }, };

export type QueryRequest = { queries: Array<QueryItem>, timeRange: TimeRange, intervalMs?: number, maxDataPoints?: number, 
/**
 * Variable values: bound as parameters in SQL, escaped into strings in PromQL, and checked
 * against the schema when used as identifiers (docs/api/datasources.md).
 */
variables: Record<string, unknown>, 
/**
 * Set by Explore: the successful queries of this run go to the caller's Explore history
 * (docs/api/explore-history.md). Dashboard panels never set it.
 */
explore?: boolean, };

export type QueryItem = { refId: string, datasourceId: string, 
/**
 * The source's own query (SQL text, PromQL, a pipeline); each plugin defines its form.
 */
query: unknown, 
/**
 * Continues a `DocumentSet` from its `nextCursor`.
 */
cursor?: string, limit?: number, };

export type PanelQueryRequest = { timeRange: TimeRange, 
/**
 * Continues the `DocumentSet` of a target, by `refId`.
 */
cursors: { [key in string]: string }, limit?: number, intervalMs?: number, maxDataPoints?: number, variables: Record<string, unknown>, };

export type VariableOptionsRequest = { timeRange: TimeRange, 
/**
 * The other variables' current values; the variable's own name is refused.
 */
variables: Record<string, unknown>, };

export type VariableOption = { value: string, label: string, };

export type VariableOptionsResponse = { 
/**
 * Distinct by `value`, in the order the query returned them.
 */
options: Array<VariableOption>, 
/**
 * True when the list was cut at the option limit or the query's row limit.
 */
truncated: boolean, };

export type TimeRange = { from: number, to: number, };

export type QueryResponse = { 
/**
 * One entry per `refId`; one failing query does not fail the others.
 */
results: { [key in string]: QueryOutcome }, };

export type QueryOutcome = { result: QueryResult, } | { error: ErrorBody, };

export type ErrorEnvelope = { error: ErrorBody, };

export type ErrorBody = { code: ErrorCode, message: string, field?: string, 
/**
 * A finer, stable reason the UI translates (see docs/api/datasources.md); `message` is the
 * English fallback.
 */
reason?: string, 
/**
 * Values the reason's text needs (`{name}`).
 */
params?: { [key in string]: string }, 
/**
 * For `internal`: the request id that the server log names next to the cause.
 */
requestId?: string, };

export type Page<T> = { items: Array<T>, nextCursor: string | null, };

export type DatasourceAccess = { read: boolean, query: boolean, write: boolean, permissions: boolean, changeTarget: boolean, };

export type ExportFormat = "csv" | "json" | "xlsx";

export type ExportLanguage = "de" | "en";

export type ExportRequest = { queries: Array<QueryItem>, timeRange: TimeRange, intervalMs?: number, maxDataPoints?: number, variables: Record<string, unknown>, 
/**
 * Analysis steps, as a panel stores them in `transformations`.
 */
steps: unknown[], format: ExportFormat, language: ExportLanguage, 
/**
 * The frame to export, by `refId`; the first frame when absent.
 */
frame?: string, 
/**
 * The file name's base, such as the Explore data source's name.
 */
title?: string, };

export type PanelExportRequest = { timeRange: TimeRange, intervalMs?: number, maxDataPoints?: number, variables: Record<string, unknown>, format: ExportFormat, language: ExportLanguage, frame?: string, };
