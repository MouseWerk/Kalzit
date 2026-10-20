// Generated from server/src/shapes.rs by `KALZIT_UPDATE_GENERATED=1 cargo test`. Do not edit.

export type Shape = "frame" | "documents" | "graph";

export type QueryResult = { "shape": "frame", frame: Frame, } | { "shape": "documents", documents: DocumentSet, } | { "shape": "graph", graph: GraphSet, };

export type Frame = { fields: Array<Field>, meta?: FrameMeta, };

export type FrameMeta = { 
/**
 * The statement as sent to the database after macros were expanded (shown in the inspector).
 */
executedQuery?: string, rowsTruncated: boolean, notices: Array<Notice>, };

export type Notice = { severity: NoticeSeverity, text: string, };

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
 * Documents with typed values (see `typed`) where JSON has no type for them.
 */
documents: unknown[], 
/**
 * Sampled from the result: every field path with its types and how many documents have it.
 */
schema: Array<FieldSchema>, nextCursor?: string, truncated?: Truncated, };

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

export type Truncated = { limit: number, };

export type GraphSet = { nodes: Array<Node>, edges: Array<Edge>, 
/**
 * Paths stay paths when the query returned them, instead of a loose set of edges.
 */
paths?: Array<GraphPath>, schema: GraphSchema, truncated?: Truncated, };

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
 * Dashboard variables; they become bind parameters, never text in the query.
 */
variables: Record<string, unknown>, };

export type QueryItem = { refId: string, datasourceId: string, 
/**
 * The source's own query (SQL text, PromQL, a pipeline); each plugin defines its form.
 */
query: unknown, 
/**
 * Continues a `DocumentSet` from its `nextCursor`.
 */
cursor?: string, limit?: number, };

export type PanelQueryRequest = { timeRange: TimeRange, intervalMs?: number, maxDataPoints?: number, variables: Record<string, unknown>, };

export type TimeRange = { from: number, to: number, };

export type QueryResponse = { 
/**
 * One entry per `refId`; one failing query does not fail the others.
 */
results: { [key in string]: QueryOutcome }, };

export type QueryOutcome = { result: QueryResult, } | { error: ErrorBody, };

export type ErrorEnvelope = { error: ErrorBody, };

export type ErrorBody = { code: string, message: string, field?: string, };

export type Page<T> = { items: Array<T>, nextCursor: string | null, };
