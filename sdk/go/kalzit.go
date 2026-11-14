// Package kalzit is a client for Kalzit's public API (docs/guide/sdk-go.md): it signs in with a
// service account token (kz_sa_...) and reads dashboards, data sources and alert rules, and runs
// queries whose results keep their native shape (frame, documents or graph).
package kalzit

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Error is an error answer of Kalzit, or a failure to reach it (Status 0, Code "network").
type Error struct {
	Status int
	ErrorBody
}

func (e *Error) Error() string {
	if e.Reason != "" {
		return fmt.Sprintf("kalzit: %s (%s, %s)", e.Message, e.Code, e.Reason)
	}
	return fmt.Sprintf("kalzit: %s (%s)", e.Message, e.Code)
}

// Client talks to one Kalzit server for one organization.
type Client struct {
	base       string
	token      string
	orgID      string
	httpClient *http.Client
	// UserAgent is sent with every request.
	UserAgent string
}

// Option changes a new Client.
type Option func(*Client)

// WithHTTPClient uses c for every request (timeouts, proxies, a private CA).
func WithHTTPClient(c *http.Client) Option {
	return func(cl *Client) { cl.httpClient = c }
}

// New makes a client for the server at baseURL (with its sub-path, if any), a service account
// token and the organization of that service account.
func New(baseURL, token, orgID string, options ...Option) (*Client, error) {
	u, err := url.Parse(baseURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, errors.New("kalzit: baseURL must be an http:// or https:// address")
	}
	if !strings.HasPrefix(token, "kz_sa_") {
		return nil, errors.New("kalzit: token must be a service account token (kz_sa_...)")
	}
	c := &Client{
		base:       strings.TrimRight(baseURL, "/"),
		token:      token,
		orgID:      orgID,
		httpClient: &http.Client{Timeout: 60 * time.Second},
		UserAgent:  "kalzit-go",
	}
	for _, o := range options {
		o(c)
	}
	return c, nil
}

// OrgID is the organization the client acts in.
func (c *Client) OrgID() string { return c.orgID }

// Do sends one request to /api<path> and decodes the answer into out (nil: ignore it).
func (c *Client) Do(ctx context.Context, method, path string, body, out any) error {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+"/api"+path, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", c.UserAgent)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := c.httpClient.Do(req)
	if err != nil {
		return &Error{Status: 0, ErrorBody: ErrorBody{Code: "network", Message: err.Error()}}
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 512<<20))
	if err != nil {
		return &Error{Status: res.StatusCode, ErrorBody: ErrorBody{Code: "network", Message: err.Error()}}
	}
	if res.StatusCode >= 300 {
		var envelope struct {
			Error ErrorBody `json:"error"`
		}
		if json.Unmarshal(data, &envelope) != nil || envelope.Error.Code == "" {
			envelope.Error = ErrorBody{Code: "internal", Message: fmt.Sprintf("Kalzit answered %d", res.StatusCode)}
		}
		return &Error{Status: res.StatusCode, ErrorBody: envelope.Error}
	}
	if out == nil || res.StatusCode == http.StatusNoContent || len(data) == 0 {
		return nil
	}
	return json.Unmarshal(data, out)
}

func (c *Client) org(path string) string {
	return "/orgs/" + url.PathEscape(c.orgID) + path
}

// all reads every page of a list.
func all[T any](ctx context.Context, c *Client, path string) ([]T, error) {
	var out []T
	cursor := ""
	for {
		q := url.Values{"limit": {"200"}}
		if cursor != "" {
			q.Set("cursor", cursor)
		}
		var page Page[T]
		if err := c.Do(ctx, http.MethodGet, path+"?"+q.Encode(), nil, &page); err != nil {
			return nil, err
		}
		out = append(out, page.Items...)
		if page.NextCursor == nil || *page.NextCursor == "" {
			return out, nil
		}
		cursor = *page.NextCursor
	}
}

// Me answers the service account itself.
func (c *Client) Me(ctx context.Context) (*Me, error) {
	var me Me
	return &me, c.Do(ctx, http.MethodGet, "/me", nil, &me)
}

// Dashboards answers the dashboards the token may read.
func (c *Client) Dashboards(ctx context.Context) ([]Dashboard, error) {
	return all[Dashboard](ctx, c, c.org("/dashboards"))
}

// Dashboard reads one dashboard with its model.
func (c *Client) Dashboard(ctx context.Context, id string) (*Dashboard, error) {
	var d Dashboard
	return &d, c.Do(ctx, http.MethodGet, c.org("/dashboards/"+url.PathEscape(id)), nil, &d)
}

// QueryPanel runs the stored queries of a dashboard's panel, as reading the dashboard allows.
func (c *Client) QueryPanel(ctx context.Context, dashboardID, panelID string, r TimeRange) (*QueryResponse, error) {
	body := map[string]any{"timeRange": r, "cursors": map[string]string{}, "variables": map[string]any{}}
	var out QueryResponse
	path := c.org("/dashboards/" + url.PathEscape(dashboardID) + "/panels/" + url.PathEscape(panelID) + "/query")
	return &out, c.Do(ctx, http.MethodPost, path, body, &out)
}

// Datasources answers the organization's data sources the token may open or query.
func (c *Client) Datasources(ctx context.Context) ([]Datasource, error) {
	return all[Datasource](ctx, c, c.org("/datasources"))
}

// Datasource reads one data source.
func (c *Client) Datasource(ctx context.Context, id string) (*Datasource, error) {
	var d Datasource
	return &d, c.Do(ctx, http.MethodGet, c.org("/datasources/"+url.PathEscape(id)), nil, &d)
}

// Query runs queries (needs datasources:query); a missing RefID becomes A, B, C, ... and nil
// Variables an empty object.
func (c *Client) Query(ctx context.Context, req QueryRequest) (*QueryResponse, error) {
	for i := range req.Queries {
		if req.Queries[i].RefID == "" {
			req.Queries[i].RefID = refID(i)
		}
	}
	if req.Variables == nil {
		req.Variables = map[string]any{}
	}
	var out QueryResponse
	return &out, c.Do(ctx, http.MethodPost, c.org("/query"), req, &out)
}

// QueryOne runs one query and answers its result; its error comes back as *Error.
func (c *Client) QueryOne(ctx context.Context, q QueryItem, r TimeRange) (*QueryResult, error) {
	if q.RefID == "" {
		q.RefID = "A"
	}
	res, err := c.Query(ctx, QueryRequest{Queries: []QueryItem{q}, TimeRange: r})
	if err != nil {
		return nil, err
	}
	outcome, ok := res.Results[q.RefID]
	switch {
	case !ok:
		return nil, &Error{ErrorBody: ErrorBody{Code: "internal", Message: "the answer holds no result for this query"}}
	case outcome.Error != nil:
		return nil, &Error{Status: http.StatusOK, ErrorBody: *outcome.Error}
	case outcome.Result == nil:
		return nil, &Error{ErrorBody: ErrorBody{Code: "internal", Message: "the outcome holds neither result nor error"}}
	}
	return outcome.Result, nil
}

func refID(i int) string {
	id := string(rune('A' + i%26))
	if i >= 26 {
		id += fmt.Sprint(i)
	}
	return id
}

// AlertRules answers the organization's alert rules (alerts:read); state filters by state.
func (c *Client) AlertRules(ctx context.Context, state string) ([]AlertRule, error) {
	path := c.org("/alerting/rules")
	if state != "" {
		path += "?" + url.Values{"state": {state}}.Encode()
	}
	var page Page[AlertRule]
	if err := c.Do(ctx, http.MethodGet, path, nil, &page); err != nil {
		return nil, err
	}
	return page.Items, nil
}

// AlertRule reads one rule with its instances.
func (c *Client) AlertRule(ctx context.Context, id string) (*AlertRule, error) {
	var r AlertRule
	return &r, c.Do(ctx, http.MethodGet, c.org("/alerting/rules/"+url.PathEscape(id)), nil, &r)
}

// PauseAlertRule pauses (true) or resumes (false) a rule (alerts:write).
func (c *Client) PauseAlertRule(ctx context.Context, id string, pause bool) (*AlertRule, error) {
	action := "/resume"
	if pause {
		action = "/pause"
	}
	var r AlertRule
	return &r, c.Do(ctx, http.MethodPost, c.org("/alerting/rules/"+url.PathEscape(id)+action), nil, &r)
}
