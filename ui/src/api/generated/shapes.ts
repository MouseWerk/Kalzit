// Generated from server/src/shapes.rs by `KALZIT_UPDATE_GENERATED=1 cargo test`. Do not edit.

export type ErrorCode = "validation" | "unauthenticated" | "forbidden" | "not_found" | "method_not_allowed" | "payload_too_large" | "conflict" | "version_conflict" | "rate_limited" | "cross_origin" | "invalid_credentials" | "invalid_code" | "confirmation_required" | "org_second_factor_required" | "org_provider_sign_in_required" | "setup_done" | "invalid_setup_token" | "setup_token_expired" | "datasource_error" | "datasource_target_blocked" | "query_timeout" | "query_rejected" | "ai_unavailable" | "ai_provider_error" | "busy" | "internal";

export type Permission = "dashboards:read" | "dashboards:write" | "dashboards:delete" | "dashboards:share" | "dashboards:public" | "folders:read" | "folders:write" | "folders:permissions" | "datasources:query" | "datasources:read" | "datasources:write" | "datasources:permissions" | "analyses:read" | "analyses:write" | "data:export" | "annotations:write" | "alerts:read" | "alerts:write" | "alerts:contacts" | "reports:read" | "reports:write" | "teams:read" | "teams:write" | "teams:members" | "users:read" | "users:invite" | "users:write" | "roles:read" | "roles:write" | "serviceaccounts:write" | "audit:read" | "plugins:configure" | "settings:read" | "settings:write" | "provisioning:read" | "provisioning:write" | "org:write" | "org:delete";

export type SettingKey = "datasources.sqlite_dirs" | "datasources.file_dirs" | "datasources.allowed_targets" | "datasources.query_timeout_secs" | "datasources.max_rows" | "datasources.max_response_bytes" | "datasources.max_parallel_queries" | "datasources.max_inflight_bytes" | "datasources.cache_enabled" | "datasources.cache_max_bytes" | "datasources.algorithm_timeout_secs" | "datasources.algorithm_max_nodes" | "datasources.algorithm_max_memory_bytes" | "datasources.algorithm_max_parallel" | "datasources.algorithm_max_results" | "datasources.algorithm_max_length" | "datasources.algorithm_max_top_k" | "datasources.algorithm_max_suggestions" | "ai.enabled" | "ai.request_timeout_secs" | "ai.user_requests_per_day" | "ai.user_tokens_per_day" | "ai.org_tokens_per_month" | "ai.max_rows_to_model" | "ai.max_tool_calls" | "ai.provider_explain" | "ai.provider_summarize" | "ai.provider_chat" | "ai.allow_org_providers" | "ai.max_concurrent" | "ai.max_concurrent_per_user" | "ai.max_concurrent_per_org" | "ai.chat_retention_days" | "ai.notice_text" | "ai.org_enabled" | "alerting.enabled" | "alerting.min_interval_secs" | "alerting.evaluation_timeout_secs" | "alerting.max_concurrent" | "alerting.max_concurrent_per_org" | "alerting.max_concurrent_per_datasource" | "alerting.max_rules_per_org" | "alerting.max_instances_per_rule" | "alerting.max_contact_points_per_rule" | "alerting.max_silences_per_org" | "alerting.max_contact_points_per_org" | "alerting.max_messages_per_org_hour" | "alerting.webhook_max_bytes" | "alerting.history_retention_days" | "alerting.max_policies_per_org" | "alerting.max_policy_depth" | "alerting.max_active_groups_per_org" | "alerting.org_enabled" | "reports.enabled" | "reports.max_reports_per_org" | "reports.max_runs_per_org_hour" | "reports.max_recipients" | "reports.max_attachment_bytes" | "reports.history_retention_days" | "reports.org_enabled" | "reports.allow_external_recipients" | "reports.external_domains" | "sharing.public_enabled" | "sharing.max_expiry_days" | "sharing.snapshot_max_bytes" | "sharing.snapshots_per_org" | "sharing.snapshot_bytes_per_org" | "sharing.org_public_enabled" | "audit.retention_days" | "usage.enabled" | "usage.retention_days" | "appearance.default_language" | "appearance.default_theme" | "sessions.lifetime_hours" | "sessions.idle_timeout_hours" | "dashboards.version_retention" | "updates.channel" | "updates.check_daily" | "updates.window" | "updates.keep_versions" | "updates.health_timeout_secs" | "plugins.catalog_enabled" | "plugins.catalog_url" | "plugins.catalog_refresh_hours" | "plugins.catalog_use_proxy" | "network.proxy_url" | "network.no_proxy" | "network.proxy_username" | "dashboards.default_time_range" | "dashboards.new_in_team_space" | "appearance.product_name" | "appearance.accent" | "appearance.density" | "appearance.font_size" | "appearance.start_page" | "appearance.time_zone" | "appearance.week_start" | "signin.local_password" | "signin.password_form" | "signin.break_glass_user" | "signin.unmapped" | "signin.default_org" | "signin.default_role" | "security.two_factor_required" | "security.two_factor_methods" | "signin.welcome" | "signin.notice" | "signin.organization" | "signin.server_name" | "signin.product_line" | "server.http_addr" | "server.https_addr" | "server.public_url" | "server.redirect_http_to_https" | "server.base_path" | "tls.cert_file" | "tls.min_version" | "tls.reload_interval_secs" | "security.trusted_proxies" | "security.forwarded_headers" | "security.hsts" | "security.hsts_max_age_secs" | "security.login_max_failures" | "security.login_window_secs" | "security.setup_max_failures" | "security.setup_window_secs" | "log.level" | "log.format" | "log.event_log" | "metrics.enabled" | "metrics.allowed_networks" | "cors.enabled" | "cors.allowed_origins" | "cors.allowed_methods" | "cors.allowed_headers" | "cors.allow_credentials" | "cors.max_age_secs" | "registration.enabled" | "registration.allowed_domains" | "registration.default_org" | "registration.default_role" | "registration.require_approval" | "registration.max_per_ip_hour" | "registration.max_per_email_day" | "registration.max_per_server_day" | "backups.schedule_enabled" | "backups.interval_hours" | "backups.keep_count" | "backups.encrypt" | "backups.allowed_dirs";

export type Shape = "frame" | "documents" | "graph" | "trace";

export type QueryResult = { "shape": "frame", frame: Frame, } | { "shape": "documents", documents: DocumentSet, } | { "shape": "graph", graph: GraphSet, } | { "shape": "trace", trace: TraceSet, };

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

export type FieldType = "time" | "number" | "int64" | "string" | "bool" | "json" | "decimal" | "date";

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
executedQuery?: string, 
/**
 * The source computes field distributions over the whole result in the database
 * (`POST /query/distribution`); without it, they count the loaded documents.
 */
distributable?: boolean, };

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
notices?: Array<Notice>, 
/**
 * Edges a link prediction step suggests (`suggested: true`, with their `score`): no data of
 * the source, so apart from `edges`. They are not counted, no later step reads them, and
 * exports leave them out unless asked to take them.
 */
suggested?: Array<Edge>, };

export type Node = { id: string, labels: Array<string>, properties: Record<string, unknown>, };

export type Edge = { id: string, type: string, from: string, to: string, properties: Record<string, unknown>, };

export type GraphPath = { nodes: Array<string>, edges: Array<string>, 
/**
 * What a step computed for this path, by name (`aggregateAlong` over the paths).
 */
values?: Record<string, unknown>, };

export type GraphSchema = { labels: Array<string>, edgeTypes: Array<string>, 
/**
 * Property keys seen per label.
 */
propertyKeys: { [key in string]: Array<string> }, };

export type TraceSet = { 
/**
 * By trace, then by start time; parents may be missing when the source did not send them.
 */
spans: Array<Span>, truncated?: Truncated, 
/**
 * What the source said about the result, such as a trace that was cut (codes as for frames).
 */
notices?: Array<Notice>, 
/**
 * The query as sent, after macros and variables were bound (shown in the inspector).
 */
executedQuery?: string, };

export type Span = { traceId: string, spanId: string, 
/**
 * None for a root span.
 */
parentSpanId?: string, 
/**
 * The service that recorded the span (`service.name`).
 */
service: string, 
/**
 * The operation (the span's name).
 */
operation: string, 
/**
 * Unix microseconds.
 */
start: number, 
/**
 * Microseconds; fractions keep the nanoseconds of very short spans.
 */
duration: number, status: SpanStatus, statusMessage?: string, kind: SpanKind, 
/**
 * Span attributes (Jaeger: tags), typed as the source sent them.
 */
attributes: Record<string, unknown>, 
/**
 * Attributes of the process or resource that recorded the span (`service.name` excluded).
 */
resource?: Record<string, unknown>, 
/**
 * The instrumentation scope (library) that recorded the span, when the source names one.
 */
scope?: SpanScope, events: Array<SpanEvent>, links: Array<SpanLink>, };

export type SpanStatus = "unset" | "ok" | "error";

export type SpanKind = "unspecified" | "internal" | "server" | "client" | "producer" | "consumer";

export type SpanScope = { name: string, version?: string, };

export type SpanEvent = { 
/**
 * Unix microseconds.
 */
time: number, name: string, attributes: Record<string, unknown>, };

export type SpanLink = { traceId: string, spanId: string, attributes: Record<string, unknown>, };

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
explore?: boolean, 
/**
 * Runs every query in its source even when the server's query cache holds its answer, and
 * keeps the new answer ("Refresh"). `Cache-Control: no-cache` does the same.
 */
refresh?: boolean, };

export type QueryItem = { refId: string, datasourceId: string, 
/**
 * The source's own query (SQL text, PromQL, a pipeline); each plugin defines its form.
 */
query: unknown, 
/**
 * Continues a `DocumentSet` from its `nextCursor`.
 */
cursor?: string, limit?: number, 
/**
 * Graph steps on this query's result (`countLabels`, `topDegree`, ...; docs/api/datasources.md),
 * all of this query, in order. The first runs in the database when the source can, the others
 * on the server; the answer is the result after them, with `steps` saying where each ran.
 */
steps?: unknown[], };

export type PanelQueryRequest = { timeRange: TimeRange, 
/**
 * Continues the `DocumentSet` of a target, by `refId`.
 */
cursors: { [key in string]: string }, limit?: number, intervalMs?: number, maxDataPoints?: number, variables: Record<string, unknown>, 
/**
 * As `QueryRequest::refresh`.
 */
refresh?: boolean, };

export type LiveSubscribe = { type: LiveSubscribeType, 
/**
 * The client's name for the subscription, 1 to 64 characters; messages about it carry it.
 */
id: string, panel?: LivePanel, queries?: Array<QueryItem>, timeRange?: TimeRange, lastMs?: number, intervalMs?: number, maxDataPoints?: number, 
/**
 * The panel's row limit (free queries carry their own `limit`).
 */
limit?: number, variables: Record<string, unknown>, 
/**
 * How often to run the queries when the source cannot report changes; the server's
 * minimum applies.
 */
refreshMs?: number, };

export type LiveSubscribeType = "subscribe";

export type LivePanel = { dashboardId: string, panelId: string, };

export type LiveUnsubscribe = { type: LiveUnsubscribeType, id: string, };

export type LiveUnsubscribeType = "unsubscribe";

export type LiveMode = "changes" | "poll";

export type LiveMessage = { "type": "subscribed", id: string, feed: string, } | { "type": "status", feed: string, mode: LiveMode, refreshMs: number, reason?: string, } | { "type": "result", feed: string, at: number, results: { [key in string]: QueryOutcome }, } | { "type": "error", id?: string, error: ErrorBody, } | { "type": "closing", error: ErrorBody, };

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

export type QueryOutcome = { result: QueryResult, 
/**
 * The graph steps the query ran, when it had any (`QueryItem::steps`).
 */
steps?: Array<StepPlace>, 
/**
 * Whether the answer came from the server's query cache, for runs that use it
 * (docs/api/datasources.md, "Query cache").
 */
cache?: CacheInfo, 
/**
 * How long the query took on the server, in milliseconds, from its start to its answer
 * (a cache hit included), for the editors' "rows and time" line.
 */
elapsedMs?: number, } | { error: ErrorBody, };

export type CacheInfo = { status: CacheStatus, 
/**
 * How old the answer is: 0 for one that just ran.
 */
ageMs: number, 
/**
 * How long the answer is kept from when it ran.
 */
ttlMs: number, };

export type CacheStatus = "hit" | "miss" | "refresh";

export type StepPlace = { id: string, ranIn: RanIn, error?: ErrorBody, 
/**
 * What a graph algorithm step found, in plain language the UI translates.
 */
summary?: StepSummary, 
/**
 * Why a graph algorithm step ran on the server (`algorithm.no_library`, ...; see
 * docs/api/settings-dashboards.md, "Graph algorithm steps").
 */
reason?: string, };

export type StepSummary = { key: string, values: Record<string, unknown>, };

export type RanIn = "database" | "server";

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
requestId?: string, 
/**
 * For `rate_limited`: seconds until another attempt can succeed (also `Retry-After`).
 */
retryAfterSecs?: number, };

export type Page<T> = { items: Array<T>, nextCursor: string | null, };

export type DatasourceAccess = { read: boolean, query: boolean, write: boolean, permissions: boolean, changeTarget: boolean, };

export type ExportFormat = "csv" | "json" | "xlsx" | "ndjson" | "graphml";

export type ExportLanguage = "de" | "en";

export type ExportRequest = { queries: Array<QueryItem>, timeRange: TimeRange, intervalMs?: number, maxDataPoints?: number, variables: Record<string, unknown>, 
/**
 * Analysis steps, as a panel stores them in `transformations`.
 */
steps: unknown[], format: ExportFormat, language: ExportLanguage, 
/**
 * The result to export, by `refId`: a frame, documents or a graph after the steps. Absent:
 * the first result the format fits, frames before documents before graphs.
 */
frame?: string, 
/**
 * The file name's base, such as the Explore data source's name.
 */
title?: string, 
/**
 * The time zone calculated fields read times in (an IANA name such as Europe/Berlin): the
 * dashboard's, else the viewer's, as the UI shows them. Absent: UTC.
 */
timeZone?: string, 
/**
 * The first day of a week for `startOf(t, 'week')`. Absent: Monday.
 */
weekStart?: "monday" | "sunday" | "saturday", };

export type PanelExportRequest = { timeRange: TimeRange, intervalMs?: number, maxDataPoints?: number, variables: Record<string, unknown>, format: ExportFormat, language: ExportLanguage, 
/**
 * The result to export, by `refId`, as for the free export.
 */
frame?: string, 
/**
 * The time zone calculated fields read times in (an IANA name such as Europe/Berlin): the
 * dashboard's, else the viewer's, as the UI shows them. Absent: UTC.
 */
timeZone?: string, 
/**
 * The first day of a week for `startOf(t, 'week')`. Absent: Monday.
 */
weekStart?: "monday" | "sunday" | "saturday", };

export type DistributionRequest = { datasourceId: string, query: unknown, timeRange: TimeRange, intervalMs?: number, variables: Record<string, unknown>, 
/**
 * The field path as its keys, unescaped (a key may hold dots, `$` or any character); `null`
 * stands for "every element of the array here", as `[]` in a schema path: `items[].price` is
 * `["items", null, "price"]`.
 */
path: Array<string | null>, 
/**
 * Most common values to answer, 1 to 100 (10).
 */
top?: number, 
/**
 * Histogram bins for numbers and dates, 1 to 100 (20).
 */
bins?: number, };

export type PanelDistributionRequest = { refId: string, timeRange: TimeRange, intervalMs?: number, variables: Record<string, unknown>, 
/**
 * As in `DistributionRequest`.
 */
path: Array<string | null>, top?: number, bins?: number, };

export type FieldDistribution = { 
/**
 * Documents in the result.
 */
total: number, 
/**
 * Documents that contain the path.
 */
documents: number, 
/**
 * Documents without it.
 */
missing: number, 
/**
 * Values at the path, array elements one by one; objects and arrays are not counted.
 */
values: number, 
/**
 * Values that are `null`.
 */
nulls: number, 
/**
 * Distinct values, counted up to 100,000; `distinctCapped` says there are more.
 */
distinct: number, distinctCapped: boolean, 
/**
 * Every value found at the path by its type (objects and arrays included), most common first.
 */
types: Array<TypeCount>, 
/**
 * The most common values, typed as in documents.
 */
top: Array<ValueCount>, 
/**
 * Whether the histogram is of numbers or of dates (Unix milliseconds); none for other values.
 */
scale?: DistributionScale, 
/**
 * Smallest and largest value (numbers, dates or else texts), typed as in documents.
 */
min?: unknown, max?: unknown, 
/**
 * Equal-width bins from the smallest to the largest value of the scale.
 */
bins: Array<DistributionBin>, };

export type DistributionScale = "number" | "date";

export type TypeCount = { 
/**
 * The type's name, as in the schema (`int`, `string`, `date`, ...).
 */
name: string, count: number, };

export type ValueCount = { value: unknown, count: number, 
/**
 * A text longer than `TEXT_CUT` characters, counted by its beginning: `value` is that
 * beginning, so it cannot be filtered by.
 */
truncated?: boolean, };

export type DistributionBin = { from: number, to: number, count: number, };

export type AiStatus = { 
/**
 * `ai.enabled` of the server and the organization. Off, nothing else is sent but
 * `orgProvidersAllowed`.
 */
enabled: boolean, 
/**
 * AI can be used here: on, and a provider is in effect for the organization.
 */
usable: boolean, 
/**
 * Whether the server lets organizations use a provider of their own
 * (`ai.allow_org_providers`), so an organization's AI page knows before AI is on.
 */
orgProvidersAllowed: boolean, 
/**
 * Whether the caller acknowledged the first-use notice for the provider in effect; the UI
 * shows the notice before the first call otherwise (`POST .../ai/notice`).
 */
noticeAcknowledged?: boolean, 
/**
 * Why it cannot be used when it is on (`ai.no_provider`).
 */
reason?: string, provider?: AiStatusProvider, 
/**
 * The provider of each function (explain and draft, summarize, the chat).
 */
functions?: AiStatusFunctions, usage?: AiStatusUsage, 
/**
 * The paragraph the administrators added to the first-use notice (`ai.notice_text`), when set.
 */
noticeText?: string, 
/**
 * The most rows, documents or nodes of one result AI receives (`ai.max_rows_to_model`).
 */
maxRowsToModel?: number, };

export type AiStatusProvider = { 
/**
 * What the first-use notice is acknowledged for.
 */
id: string, 
/**
 * The name the administrators gave it.
 */
name: string, 
/**
 * `openai` or `anthropic`.
 */
kind: string, model: string, 
/**
 * Where data goes: the host of the provider's base URL (never the whole URL).
 */
host: string, 
/**
 * `org` when the organization's own provider is in effect, else `server`.
 */
scope: string, 
/**
 * Host and port of the base URL (`llm.intern:11434`), never the path or credentials.
 */
endpoint: string, 
/**
 * Whether data leaves the installation's own network: as the administrators say, or, when
 * they left it open, judged from the address (`stays_in_network`; `leavesNetworkEstimated`).
 */
leavesNetwork: boolean, 
/**
 * The answer comes from the address, not from the administrators: an estimate (a gateway
 * in the own network may forward to a cloud model).
 */
leavesNetworkEstimated: boolean, 
/**
 * Whether calls through this provider can run: false when its key cannot be read.
 */
usable: boolean, 
/**
 * Why it cannot (`ai.key_unreadable`).
 */
reason?: string, 
/**
 * The last connection test: passed, failed, or (absent) not tested since the last change.
 */
reachable?: boolean, 
/**
 * Whether the caller acknowledged the first-use notice for this provider.
 */
noticeAcknowledged: boolean, };

export type AiStatusFunctions = { explain?: AiStatusProvider, summarize?: AiStatusProvider, chat?: AiStatusProvider, };

export type AiStatusUsage = { requests: number, tokens: number, requestsLimit: number, tokensLimit: number, orgTokensMonth: number, orgTokensMonthLimit: number, };

export type SharedTimeRange = { from: string, to: string, };

export type SuspendedReason = "sharingOff" | "creatorRemoved" | "creatorRights" | "dashboardTrashed";

export type PublicDashboard = { title: string, refreshSeconds?: number, timeZone?: string, 
/**
 * `monday`, `sunday` or `saturday`.
 */
weekStart?: string, fiscalYearStartMonth?: number, nowDelay?: string, 
/**
 * `off`, `crosshair` or `tooltip`.
 */
sharedCursor?: string, 
/**
 * The variables with their fixed values, for the header; constants are left out.
 */
variables: Array<PublicVariable>, rows: Array<PublicRow>, panels: Array<PublicPanel>, };

export type PublicVariable = { name: string, 
/**
 * `query`, `custom`, `textbox` or `interval`.
 */
type: string, label?: string, 
/**
 * The fixed value (a list for several values); absent when there is none.
 */
value?: unknown, };

export type PublicRow = { id: string, title: string, collapsed: boolean, };

export type PublicPanel = { id: string, type: string, title: string, description?: string, grid: PublicGrid, rowId?: string, timeFrom?: string, timeShift?: string, transparent: boolean, 
/**
 * The panel's shown queries by reference id only. Its steps ran on the server
 * (`shown_response`): the answers are what the panel draws, without steps of their own.
 */
targets: Array<PublicTarget>, 
/**
 * The panel's options and field settings without links (`dataLinks`, cell `link`).
 */
options: unknown, fieldConfig: unknown, };

export type PublicGrid = { x: number, y: number, w: number, h: number, };

export type PublicTarget = { refId: string, hide: boolean, };

export type SharingLimits = { 
/**
 * `sharing.public_enabled`.
 */
serverPublic: boolean, 
/**
 * `sharing.org_public_enabled`; an organization can only turn public sharing off.
 */
orgPublic: boolean, 
/**
 * `sharing.max_expiry_days`.
 */
maxExpiryDays: number, 
/**
 * `sharing.snapshot_max_bytes`.
 */
snapshotMaxBytes: number, };

export type ShareStatus = "active" | "suspended" | "expired" | "revoked";

export type PublicLink = { id: string, dashboardId: string, 
/**
 * Absent when the caller may not read the dashboard.
 */
dashboardTitle?: string, createdBy: string | null, createdByName: string | null, createdAt: number, expiresAt: number, 
/**
 * How far back a visitor may look: any range from `now - maxWindowMs` to now.
 */
maxWindowMs: number, 
/**
 * The range the page opens with.
 */
timeRange: SharedTimeRange, 
/**
 * The fixed variable values.
 */
variables: Record<string, unknown>, 
/**
 * Page loads by visitors; nothing else about them is kept.
 */
views: number, lastViewedAt: number | null, revokedAt: number | null, status: ShareStatus, suspendedReason?: SuspendedReason, };

export type CreatePublicLink = { 
/**
 * Unix milliseconds; default 30 days from now, at most `sharing.max_expiry_days` from now.
 */
expiresAt?: number, 
/**
 * Default 7 days; 1 minute up to `sharing.max_expiry_days`.
 */
maxWindowMs?: number, 
/**
 * Default: the dashboard's range.
 */
timeRange?: SharedTimeRange, 
/**
 * Default: the dashboard's current values. Constants are the dashboard's own.
 */
variables?: Record<string, unknown>, };

export type CreatedPublicLink = { link: PublicLink, 
/**
 * The link's token, shown this once: the page is `/public/dashboards/{token}`.
 */
token: string, };

export type ChangeExpiry = { expiresAt: number, };

export type PublicLinkView = { dashboard: PublicDashboard, timeRange: SharedTimeRange, maxWindowMs: number, expiresAt: number, 
/**
 * The server's clock now: the window is counted from it, so the page counts its ranges from
 * it too instead of from a browser clock that may be off.
 */
now: number, };

export type PublicPanelQuery = { timeRange: TimeRange, };

export type SnapshotSummary = { id: string, dashboardId: string, 
/**
 * Absent when the caller may not read the dashboard.
 */
dashboardTitle?: string, 
/**
 * Absent when the caller may not read the dashboard: by default it is the dashboard's title.
 */
title?: string, public: boolean, createdBy: string | null, createdByName: string | null, createdAt: number, expiresAt: number, 
/**
 * The absolute range the panels ran for.
 */
timeRange: TimeRange, sizeBytes: number, views: number, lastViewedAt: number | null, revokedAt: number | null, status?: ShareStatus, suspendedReason?: SuspendedReason, };

export type CreateSnapshot = { 
/**
 * Default: the dashboard's title.
 */
title?: string, 
/**
 * The absolute range every panel runs for.
 */
timeRange: TimeRange, 
/**
 * Default: the dashboard's current values.
 */
variables?: Record<string, unknown>, expiresAt?: number, 
/**
 * A public snapshot gets a token; it needs `dashboards:public`. Default `false`.
 */
public?: boolean, };

export type CreatedSnapshot = { snapshot: SnapshotSummary, 
/**
 * A public snapshot's token, shown this once: the page is `/public/snapshots/{token}`.
 */
token?: string, };

export type SnapshotView = { snapshot: SnapshotSummary, dashboard: PublicDashboard, results: Record<string, QueryResponse>, };

export type PublicSnapshotView = { title: string, timeRange: TimeRange, createdAt: number, expiresAt: number, dashboard: PublicDashboard, results: Record<string, QueryResponse>, };

export type ResourceKind = "datasource" | "role" | "dashboard" | "alertRule";

export type RequestFile = { 
/**
 * Relative to the set's folder, with `/`.
 */
path: string, content: string, };

export type SetRequest = { 
/**
 * The provisioning set; `default` when left out.
 */
set: string | null, files: Array<RequestFile>, 
/**
 * Delete the set's resources whose files are gone.
 */
prune: boolean, 
/**
 * The values of the environment variables the data source files name, read where the files
 * were read (`kalzit provision`). The server never reads its own environment for them.
 */
secretValues: { [key in string]: string }, };

export type Action = "create" | "update" | "adopt" | "delete" | "unchanged" | "orphaned";

export type Change = { kind: ResourceKind, uid: string, 
/**
 * The resource's name or title.
 */
name: string, action: Action, 
/**
 * `null` for a resource that does not exist yet.
 */
resourceId: string | null, 
/**
 * The file, relative to the set's folder; for an orphan, the one it came from.
 */
path: string, 
/**
 * The stored resource differs from what was applied last (edited after an unlock, changed
 * some other way, or gone).
 */
drifted: boolean, 
/**
 * What an update changes, as paths into the file's `spec` (`settings.host`, `model.panels`).
 */
fields: Array<string>, };

export type Counts = { create: number, update: number, adopt: number, delete: number, unchanged: number, orphaned: number, drifted: number, };

export type Plan = { orgId: string, set: string, prune: boolean, changes: Array<Change>, counts: Counts, };

export type ApplyWarning = { kind: ResourceKind, uid: string, 
/**
 * `datasource.connection_failed` for a failed connection test.
 */
reason: string, message: string, };

export type ApplyResult = { plan: Plan, warnings: Array<ApplyWarning>, };

export type Provisioned = { set: string, kind: ResourceKind, uid: string, resourceId: string, 
/**
 * Empty when the resource is gone.
 */
name: string, path: string, checksum: string, appliedAt: number, 
/**
 * The person or service account that applied it last.
 */
appliedBy: string | null, 
/**
 * Unlocked for edits until the set is applied again.
 */
unlockedAt: number | null, unlockedBy: string | null, drifted: boolean, 
/**
 * The resource was deleted some other way; the next apply makes it again.
 */
missing: boolean, };

export type ExportFile = { path: string, content: string, };

export type ExportSkip = { kind: ResourceKind, resourceId: string, name: string, reason: string, };

export type Export = { set: string, 
/**
 * `org.yaml` first, then one file per resource.
 */
files: Array<ExportFile>, skipped: Array<ExportSkip>, };

export type ItemStatus = "converted" | "approximated" | "skipped";

export type ItemKind = "dashboard" | "panel" | "row" | "query" | "variable" | "annotation" | "link";

export type ImportItem = { kind: ItemKind, 
/**
 * Names the item in the Grafana dashboard on its own: `panel 4 "CPU"`, `variable host`.
 */
name: string, 
/**
 * The item's title alone (`CPU`, `host`; empty when it has none), for a list that shows the
 * kind next to it. Absent in reports of an older server.
 */
title: string | null, status: ItemStatus, 
/**
 * What changed (approximated) or why it was left out (skipped); empty when converted.
 */
notes: Array<ImportNote>, };

export type ImportNote = { 
/**
 * `legend_format`, `no_mapping`, ...; the UI's key is `provisioning.note.<code>`.
 */
code: string, params: { [key in string]: string }, text: string, };

export type ImportCounts = { converted: number, approximated: number, skipped: number, };

export type ImportReport = { 
/**
 * `grafana`.
 */
source: string, sourceVersion: number | null, title: string, items: Array<ImportItem>, counts: ImportCounts, };

export type GrafanaImportRequest = { dashboard: unknown, datasources: { [key in string]: string }, folderId?: string, 
/**
 * Converts and reports without saving.
 */
dryRun: boolean, };

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export type Schedule = { "kind": "daily", time: string, } | { "kind": "weekly", time: string, weekdays: Array<Weekday>, } | { "kind": "monthly", time: string, day: number, } | { "kind": "cron", expression: string, };

export type ReportFormat = "pdf" | "csv";

export type ReportLanguage = "de" | "en";

export type Recipient = { userId?: string, email?: string, };

export type ReportTimeRange = { from: string, to: string, };

export type ReportInput = { name: string, description?: string, dashboardId: string, 
/**
 * The panels in the report, in the dashboard's order; absent or `null` for all of them.
 */
panelIds?: Array<string>, 
/**
 * Absent or `null`: the dashboard's own range.
 */
timeRange?: ReportTimeRange, 
/**
 * Fixed values of the dashboard's variables; the others take the dashboard's saved value.
 */
variables?: Record<string, unknown>, schedule: Schedule, 
/**
 * An IANA time zone: when the schedule runs and how times in the report read.
 */
timeZone: string, formats: Array<ReportFormat>, language: ReportLanguage, recipients?: Array<Recipient>, paused?: boolean, 
/**
 * The version an update started from.
 */
version?: number, };

export type RecipientView = { userId?: string, 
/**
 * `null` for a member who left the organization (left out of every run).
 */
email: string | null, name?: string, 
/**
 * An address outside the organization.
 */
external: boolean, };

export type Report = { id: string, name: string, description: string, dashboardId: string, dashboardTitle: string, panelIds: Array<string> | null, timeRange: ReportTimeRange | null, variables: Record<string, unknown>, schedule: Schedule, timeZone: string, formats: Array<ReportFormat>, language: ReportLanguage, recipients: Array<RecipientView>, paused: boolean, 
/**
 * The next scheduled run; `null` while paused or while reports are off.
 */
nextRunAt: number | null, 
/**
 * Whose current rights the runs use: who created the report.
 */
ownerId: string, ownerName: string | null, 
/**
 * Set while a right the report needs is missing (the creator's, or the creator left); the
 * report resumes at the first scheduled time the right is back. Missed times are not made up.
 */
suspended: Suspension | null, lastRun: ReportRun | null, createdBy: string | null, createdAt: number, updatedAt: number, version: number, };

export type Suspension = { code: string, message: string, since: number, };

export type RunTrigger = "schedule" | "manual";

export type RunStatus = "queued" | "running" | "ok" | "partial" | "failed" | "suspended" | "skipped";

export type RunError = { code: string, message: string, };

export type ReportRun = { id: string, trigger: RunTrigger, 
/**
 * 1, or 2 for the one retry five minutes after a failure.
 */
attempt: number, triggeredBy: string | null, scheduledFor: number | null, status: RunStatus, createdAt: number, startedAt: number | null, finishedAt: number | null, error: RunError | null, recipients: number, sent: number, skippedRecipients: number, 
/**
 * Recipients who got the PDF only: without `data:export`, and every outside address.
 */
csvWithheld: number, attachmentBytes: number | null, pages: number | null, };

export type ReportLimits = { maxReportsPerOrg: number, maxRunsPerOrgHour: number, maxRecipients: number, maxAttachmentBytes: number, historyRetentionDays: number, };

export type ReportsStatus = { 
/**
 * Reports run on this server (`reports.enabled`).
 */
enabled: boolean, 
/**
 * A mail server is set up; without one every run fails.
 */
mailConfigured: boolean, 
/**
 * The organization allows addresses outside it.
 */
allowExternalRecipients: boolean, 
/**
 * ... in these mail domains only; empty for any.
 */
externalDomains: Array<string>, limits: ReportLimits, reports: number, };

export type SendNow = { run: ReportRun, };
