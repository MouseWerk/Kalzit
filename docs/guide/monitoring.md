English | [Deutsch](de/monitoring.md)

# Monitoring

Kalzit answers health checks and, when you turn it on, Prometheus metrics.

## Health

- `GET /healthz`: the process is up (`ok`).
- `GET /readyz`: the database answers and the server takes requests.

Both need no sign-in and also answer on the HTTP port when HTTPS is on, and at the root when
Kalzit runs under a sub-path ([reverse proxy](reverse-proxy.md)).

## Prometheus metrics

`/metrics` serves the Prometheus text format. It is **off by default** and never open to
everyone: turning it on needs a token, allowed networks, or both (then both must match).

```toml
[metrics]
enabled = true                              # KALZIT_METRICS_ENABLED
allowed_networks = ["10.0.0.0/8"]           # KALZIT_METRICS_ALLOWED_NETWORKS
# token: give it in KALZIT_METRICS_TOKEN, not in this file
```

The token needs at least 16 characters, 8 of them different; make one with
`openssl rand -hex 32`.

The settings are read at start; restart Kalzit after changing them. Settings > General shows them
read-only. A token in `kalzit.toml` works but logs a warning at start, since everyone who may read
the file sees it; put it in the service's environment instead (systemd `Environment=` in a drop-in
readable by root only, Docker secrets as an environment variable, the Windows service's
environment).

Behind a trusted proxy, the allowed networks are compared with the client address the proxy
forwards ([HTTPS and certificates](https.md#client-address-scheme-and-host-behind-a-proxy)).
Do not list the network of a reverse proxy in `allowed_networks` unless that proxy is in
`security.trusted_proxies`: otherwise every request it passes on comes from the proxy's address,
and anyone on the internet who reaches the proxy can read `/metrics`. The same holds for loopback
(`127.0.0.1`, `::1`) when a proxy runs on the same machine. Kalzit logs a warning at start when
`allowed_networks` covers loopback or a trusted proxy; prefer the token in those setups.
Answers: `404` while metrics are off, `403` from another network, `401` without the right token.

Prometheus:

```yaml
scrape_configs:
  - job_name: kalzit
    scheme: https
    metrics_path: /metrics          # /kalzit/metrics under a sub-path
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/kalzit-token
    static_configs:
      - targets: ["kalzit.example.com"]
```

### What is measured

| Metric | Type | Meaning |
|---|---|---|
| `kalzit_build_info{version}` | gauge | The running version |
| `process_start_time_seconds` | gauge | Start of the process (Unix time) |
| `process_cpu_seconds_total` | counter | CPU time of the process (Linux, Windows) |
| `process_resident_memory_bytes` | gauge | Memory in RAM (Linux: resident set, Windows: working set) |
| `kalzit_http_requests_total{code}` | counter | Answered requests by status class (`2xx`, `4xx`, ...) |
| `kalzit_http_requests_in_flight` | gauge | Requests being answered now |
| `kalzit_http_request_duration_seconds` | histogram | Time to answer a request |
| `kalzit_query_duration_seconds{kind,outcome}` | histogram | Data source queries by source kind (`postgres`, `neo4j`, a plugin's kind) and `ok`, `error` or `timeout`; answers from the cache are not included |
| `kalzit_query_cache_hits_total`, `kalzit_query_cache_misses_total` | counter | Query cache lookups |
| `kalzit_query_cache_entries`, `kalzit_query_cache_bytes` | gauge | What the query cache holds |
| `kalzit_sessions_active` | gauge | Sign-in sessions that have not ended |
| `kalzit_plugin_processes{state}` | gauge | Plugin processes by state (`running`, `waiting`, `stopped`, `idle`) |
| `kalzit_alert_evaluations_total{outcome}` | counter | Scheduled alert rule evaluations, `ok` or ending in the state `error` |
| `kalzit_alert_evaluations_skipped_total` | counter | Scheduled evaluations skipped because the rule could not start before its next slot |
| `kalzit_alert_deliveries_total{result}` | counter | Attempts to deliver an alert notification, `ok` or `failed` |

Labels never carry user names, email or client addresses, query text, ids of dashboards or data
sources, or secrets. With several servers on one database, each server reports its own counts;
`kalzit_sessions_active` counts the sessions of all of them.
