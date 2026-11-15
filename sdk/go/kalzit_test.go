package kalzit

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const (
	token = "kz_sa_0123456789abcdef0123456789abcdef01234567"
	org   = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"
)

// fake answers by "METHOD path?query" and checks the token on every request.
func fake(t *testing.T, answers map[string]func(body []byte) (int, string)) *Client {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+token {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = io.WriteString(w, `{"error":{"code":"unauthenticated","message":"no token"}}`)
			return
		}
		key := r.Method + " " + r.URL.Path
		if r.URL.RawQuery != "" {
			key += "?" + r.URL.RawQuery
		}
		answer, ok := answers[key]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			_, _ = io.WriteString(w, `{"error":{"code":"not_found","message":"`+key+`"}}`)
			return
		}
		body, _ := io.ReadAll(r.Body)
		status, text := answer(body)
		w.WriteHeader(status)
		_, _ = io.WriteString(w, text)
	}))
	t.Cleanup(srv.Close)
	c, err := New(srv.URL+"/kalzit/", token, org)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func ok(text string) func([]byte) (int, string) {
	return func([]byte) (int, string) { return http.StatusOK, text }
}

func TestNewRefusesOtherTokensAndAddresses(t *testing.T) {
	if _, err := New("https://kalzit.example.com", "session", org); err == nil {
		t.Fatal("a session token was accepted")
	}
	if _, err := New("ftp://kalzit.example.com", token, org); err == nil {
		t.Fatal("an ftp address was accepted")
	}
}

func TestListsFollowTheCursor(t *testing.T) {
	base := "/kalzit/api/orgs/" + org + "/dashboards"
	answers := map[string]func([]byte) (int, string){}
	answers["GET "+base+"?limit=200"] = ok(`{"items":[{"id":"d1","title":"Eins"}],"nextCursor":"c2"}`)
	answers["GET "+base+"?cursor=c2&limit=200"] = ok(`{"items":[{"id":"d2","title":"Zwei"}],"nextCursor":null}`)
	c := fake(t, answers)
	ds, err := c.Dashboards(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(ds) != 2 || ds[1].Title != "Zwei" {
		t.Fatalf("got %+v", ds)
	}
}

func TestQueriesKeepTheirShapes(t *testing.T) {
	var sent QueryRequest
	c := fake(t, map[string]func([]byte) (int, string){
		"POST /kalzit/api/orgs/" + org + "/query": func(body []byte) (int, string) {
			_ = json.Unmarshal(body, &sent)
			return http.StatusOK, `{"results":{
				"A":{"result":{"shape":"frame","frame":{"fields":[{"name":"n","type":"number","values":[1,2]}]}}},
				"B":{"result":{"shape":"documents","documents":{"documents":[{"_id":{"$type":"objectId","value":"x"}}]}}},
				"C":{"result":{"shape":"graph","graph":{"nodes":[{"id":"1","labels":["P"],"properties":{}}],"edges":[]}}},
				"D":{"error":{"code":"query_rejected","message":"write","reason":"query.write_refused"}}}}`
		},
	})
	res, err := c.Query(context.Background(), QueryRequest{
		Queries: []QueryItem{
			{DatasourceID: "pg", Query: "SELECT 1"},
			{DatasourceID: "mongo", Query: []any{map[string]any{"$match": map[string]any{}}}},
			{DatasourceID: "neo", Query: "MATCH (n) RETURN n"},
			{DatasourceID: "pg", Query: "DELETE FROM t"},
		},
		TimeRange: TimeRange{From: 0, To: 1000},
	})
	if err != nil {
		t.Fatal(err)
	}
	if sent.Queries[3].RefID != "D" || sent.Variables == nil {
		t.Fatalf("sent %+v", sent)
	}
	a := res.Results["A"].Result
	frame, err := a.AsFrame()
	if err != nil || frame.Rows()[1]["n"] != 2.0 {
		t.Fatalf("frame %+v %v", frame, err)
	}
	if _, err := a.AsGraph(); err == nil {
		t.Fatal("a frame became a graph")
	}
	if docs, err := res.Results["B"].Result.AsDocuments(); err != nil || len(docs.Documents) != 1 {
		t.Fatalf("documents %+v %v", docs, err)
	}
	if g, err := res.Results["C"].Result.AsGraph(); err != nil || g.Nodes[0].Labels[0] != "P" {
		t.Fatalf("graph %+v %v", g, err)
	}
	if res.Results["D"].Error.Reason != "query.write_refused" {
		t.Fatalf("D %+v", res.Results["D"])
	}
}

func TestErrorsCarryCodeReasonAndRetry(t *testing.T) {
	c := fake(t, map[string]func([]byte) (int, string){
		"GET /kalzit/api/orgs/" + org + "/alerting/rules?state=firing": func([]byte) (int, string) {
			return http.StatusTooManyRequests, `{"error":{"code":"rate_limited","message":"slow","retryAfterSecs":30}}`
		},
	})
	_, err := c.AlertRules(context.Background(), "firing")
	var kerr *Error
	if !errors.As(err, &kerr) || kerr.Code != "rate_limited" || kerr.RetryAfterSecs != 30 || kerr.Status != 429 {
		t.Fatalf("got %v", err)
	}
	if !strings.Contains(kerr.Error(), "rate_limited") {
		t.Fatal(kerr.Error())
	}
}

func TestPanelQueriesAndPausedRules(t *testing.T) {
	var panelBody map[string]any
	answers := map[string]func([]byte) (int, string){}
	answers["POST /kalzit/api/orgs/"+org+"/dashboards/d1/panels/p1/query"] = func(body []byte) (int, string) {
		_ = json.Unmarshal(body, &panelBody)
		return http.StatusOK, `{"results":{}}`
	}
	answers["POST /kalzit/api/orgs/"+org+"/alerting/rules/r1/pause"] = ok(`{"id":"r1","name":"CPU"}`)
	c := fake(t, answers)
	if _, err := c.QueryPanel(context.Background(), "d1", "p1", TimeRange{From: 0, To: 1}); err != nil {
		t.Fatal(err)
	}
	if panelBody["timeRange"] == nil || panelBody["variables"] == nil {
		t.Fatalf("sent %+v", panelBody)
	}
	rule, err := c.PauseAlertRule(context.Background(), "r1", true)
	if err != nil || rule.Name != "CPU" {
		t.Fatalf("%+v %v", rule, err)
	}
}

func TestQueryOneAnswersTheErrorOfItsQuery(t *testing.T) {
	c := fake(t, map[string]func([]byte) (int, string){
		"POST /kalzit/api/orgs/" + org + "/query": ok(`{"results":{"A":{"error":{"code":"query_timeout","message":"slow"}}}}`),
	})
	_, err := c.QueryOne(context.Background(), QueryItem{DatasourceID: "pg", Query: "SELECT 1"}, TimeRange{})
	var kerr *Error
	if !errors.As(err, &kerr) || kerr.Code != "query_timeout" {
		t.Fatalf("got %v", err)
	}
}

func TestTracesKeepTheirSpans(t *testing.T) {
	c := fake(t, map[string]func([]byte) (int, string){
		"POST /kalzit/api/orgs/" + org + "/query": ok(`{"results":{"A":{"result":{"shape":"trace","trace":{"spans":[
			{"traceId":"t1","spanId":"s1","service":"checkout","operation":"POST /pay","start":1700000000000000,
			 "duration":1250.5,"status":"error","kind":"server","attributes":{"http.status_code":500},
			 "events":[{"time":1700000000000100,"name":"retry","attributes":{}}],"links":[]}]}}}}}`),
	})
	res, err := c.QueryOne(context.Background(), QueryItem{DatasourceID: "tempo", Query: "{ status = error }"}, TimeRange{})
	if err != nil {
		t.Fatal(err)
	}
	trace, err := res.AsTrace()
	if err != nil || len(trace.Spans) != 1 || trace.Spans[0].Service != "checkout" || trace.Spans[0].Duration != 1250.5 {
		t.Fatalf("trace %+v %v", trace, err)
	}
	if trace.Spans[0].Events[0].Name != "retry" {
		t.Fatalf("events %+v", trace.Spans[0].Events)
	}
	if _, err := res.AsFrame(); err == nil {
		t.Fatal("a trace became a frame")
	}
}