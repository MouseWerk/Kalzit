package kalzit

import (
	"encoding/json"
	"fmt"
)

// The wire types of Kalzit's API, hand-written after server/src/shapes.rs. Every query result
// keeps its native shape: a frame, a set of documents, a graph or a trace; nothing converts one
// into another on its own.

// Shape names the form of a query result.
type Shape string

const (
	ShapeFrame     Shape = "frame"
	ShapeDocuments Shape = "documents"
	ShapeGraph     Shape = "graph"
	ShapeTrace     Shape = "trace"
)

// TimeRange is a time range in Unix milliseconds.
type TimeRange struct {
	From int64 `json:"from"`
	To   int64 `json:"to"`
}

// Field is one column of a frame. Values keep their JSON form: numbers as float64, int64 values
// as decimal strings, times as Unix milliseconds, missing values as nil.
type Field struct {
	Name   string            `json:"name"`
	Type   string            `json:"type"`
	Unit   string            `json:"unit,omitempty"`
	Labels map[string]string `json:"labels,omitempty"`
	Values []any             `json:"values"`
}

// Frame is a table of fields of equal length.
type Frame struct {
	Fields []Field          `json:"fields"`
	Meta   *json.RawMessage `json:"meta,omitempty"`
}

// Rows answers the frame's rows as maps from field name to value.
func (f *Frame) Rows() []map[string]any {
	if len(f.Fields) == 0 {
		return nil
	}
	rows := make([]map[string]any, len(f.Fields[0].Values))
	for i := range rows {
		row := make(map[string]any, len(f.Fields))
		for _, field := range f.Fields {
			if i < len(field.Values) {
				row[field.Name] = field.Values[i]
			}
		}
		rows[i] = row
	}
	return rows
}

// DocumentSet holds documents as the source sent them; values JSON has no type for come as
// {"$type": ..., "value": ...}.
type DocumentSet struct {
	Documents  []json.RawMessage `json:"documents"`
	NextCursor *string           `json:"nextCursor,omitempty"`
	Schema     *json.RawMessage  `json:"schema,omitempty"`
	Truncated  *json.RawMessage  `json:"truncated,omitempty"`
}

// Node is a graph node.
type Node struct {
	ID         string         `json:"id"`
	Labels     []string       `json:"labels"`
	Properties map[string]any `json:"properties"`
}

// Edge is a graph edge.
type Edge struct {
	ID         string         `json:"id"`
	Type       string         `json:"type"`
	From       string         `json:"from"`
	To         string         `json:"to"`
	Properties map[string]any `json:"properties"`
}

// GraphSet holds nodes, edges and paths.
type GraphSet struct {
	Nodes  []Node           `json:"nodes"`
	Edges  []Edge           `json:"edges"`
	Paths  *json.RawMessage `json:"paths,omitempty"`
	Schema *json.RawMessage `json:"schema,omitempty"`
}

// Span is one span of a trace. Times are Unix microseconds; Duration keeps fractions of very
// short spans.
type Span struct {
	TraceID       string         `json:"traceId"`
	SpanID        string         `json:"spanId"`
	ParentSpanID  string         `json:"parentSpanId,omitempty"`
	Service       string         `json:"service"`
	Operation     string         `json:"operation"`
	Start         float64        `json:"start"`
	Duration      float64        `json:"duration"`
	Status        string         `json:"status"`
	StatusMessage string         `json:"statusMessage,omitempty"`
	Kind          string         `json:"kind"`
	Attributes    map[string]any `json:"attributes"`
	Resource      map[string]any `json:"resource,omitempty"`
	Scope         *SpanScope     `json:"scope,omitempty"`
	Events        []SpanEvent    `json:"events"`
	Links         []SpanLink     `json:"links"`
}

// SpanScope is the instrumentation library that recorded a span.
type SpanScope struct {
	Name    string `json:"name"`
	Version string `json:"version,omitempty"`
}

// SpanEvent is an event within a span.
type SpanEvent struct {
	Time       float64        `json:"time"`
	Name       string         `json:"name"`
	Attributes map[string]any `json:"attributes"`
}

// SpanLink points at a span of another trace.
type SpanLink struct {
	TraceID    string         `json:"traceId"`
	SpanID     string         `json:"spanId"`
	Attributes map[string]any `json:"attributes"`
}

// TraceSet holds the spans of one or more traces, by trace and then by start time.
type TraceSet struct {
	Spans         []Span           `json:"spans"`
	Truncated     *json.RawMessage `json:"truncated,omitempty"`
	Notices       *json.RawMessage `json:"notices,omitempty"`
	ExecutedQuery string           `json:"executedQuery,omitempty"`
}

// QueryResult is exactly one of a frame, documents, a graph or a trace, as Shape says.
type QueryResult struct {
	Shape     Shape        `json:"shape"`
	Frame     *Frame       `json:"frame,omitempty"`
	Documents *DocumentSet `json:"documents,omitempty"`
	Graph     *GraphSet    `json:"graph,omitempty"`
	Trace     *TraceSet    `json:"trace,omitempty"`
}

// AsFrame answers the frame, or an error when the result is of another shape.
func (r *QueryResult) AsFrame() (*Frame, error) {
	if r.Shape != ShapeFrame || r.Frame == nil {
		return nil, fmt.Errorf("kalzit: the result is %s, not frame", r.Shape)
	}
	return r.Frame, nil
}

// AsDocuments answers the documents, or an error when the result is of another shape.
func (r *QueryResult) AsDocuments() (*DocumentSet, error) {
	if r.Shape != ShapeDocuments || r.Documents == nil {
		return nil, fmt.Errorf("kalzit: the result is %s, not documents", r.Shape)
	}
	return r.Documents, nil
}

// AsGraph answers the graph, or an error when the result is of another shape.
func (r *QueryResult) AsGraph() (*GraphSet, error) {
	if r.Shape != ShapeGraph || r.Graph == nil {
		return nil, fmt.Errorf("kalzit: the result is %s, not graph", r.Shape)
	}
	return r.Graph, nil
}

// AsTrace answers the trace, or an error when the result is of another shape.
func (r *QueryResult) AsTrace() (*TraceSet, error) {
	if r.Shape != ShapeTrace || r.Trace == nil {
		return nil, fmt.Errorf("kalzit: the result is %s, not trace", r.Shape)
	}
	return r.Trace, nil
}

// ErrorBody is the "error" of an error answer.
type ErrorBody struct {
	Code           string            `json:"code"`
	Message        string            `json:"message"`
	Field          string            `json:"field,omitempty"`
	Reason         string            `json:"reason,omitempty"`
	Params         map[string]string `json:"params,omitempty"`
	RequestID      string            `json:"requestId,omitempty"`
	RetryAfterSecs int               `json:"retryAfterSecs,omitempty"`
}

// QueryOutcome is a result or an error, per refId.
type QueryOutcome struct {
	Result    *QueryResult `json:"result,omitempty"`
	Error     *ErrorBody   `json:"error,omitempty"`
	ElapsedMs *float64     `json:"elapsedMs,omitempty"`
}

// QueryResponse holds one outcome per refId; one failing query does not fail the others.
type QueryResponse struct {
	Results map[string]QueryOutcome `json:"results"`
}

// QueryItem is one query in the source's own language.
type QueryItem struct {
	RefID        string `json:"refId"`
	DatasourceID string `json:"datasourceId"`
	Query        any    `json:"query"`
	Cursor       string `json:"cursor,omitempty"`
	Limit        int    `json:"limit,omitempty"`
}

// QueryRequest runs queries over a time range.
type QueryRequest struct {
	Queries       []QueryItem    `json:"queries"`
	TimeRange     TimeRange      `json:"timeRange"`
	Variables     map[string]any `json:"variables"`
	MaxDataPoints int            `json:"maxDataPoints,omitempty"`
	Refresh       bool           `json:"refresh,omitempty"`
}

// Page is one page of a list.
type Page[T any] struct {
	Items      []T     `json:"items"`
	NextCursor *string `json:"nextCursor"`
}

// Me is the signed-in account (for a token: its service account).
type Me struct {
	ID            string `json:"id"`
	Email         string `json:"email"`
	Name          string `json:"name"`
	IsServerAdmin bool   `json:"isServerAdmin"`
	Orgs          []struct {
		ID   string `json:"id"`
		Name string `json:"name"`
		Role string `json:"role"`
	} `json:"orgs"`
}

// Dashboard is a dashboard as lists and reads answer it; Model is set when one is read.
type Dashboard struct {
	ID      string          `json:"id"`
	Title   string          `json:"title"`
	Version int64           `json:"version,omitempty"`
	Model   json.RawMessage `json:"model,omitempty"`
}

// Datasource is a data source of the organization.
type Datasource struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Kind string `json:"kind"`
}

// AlertRule is an alert rule (docs/api/alerting.md, "Rules").
type AlertRule struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	State string `json:"state,omitempty"`
	// Instances are set when one rule is read.
	Instances []AlertInstance `json:"instances,omitempty"`
}

// AlertInstance is one series of a rule.
type AlertInstance struct {
	Fingerprint string            `json:"fingerprint"`
	State       string            `json:"state"`
	Labels      map[string]string `json:"labels,omitempty"`
}
