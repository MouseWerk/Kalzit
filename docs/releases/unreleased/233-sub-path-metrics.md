## Improved

- Kalzit can run under a sub-path behind a reverse proxy, such as `https://example.com/kalzit/`:
  set `server.base_path = "/kalzit"` and restart. Pages, API, live updates, sign-in callbacks,
  mail links and cookies all follow it ([guide](../../guide/reverse-proxy.md)).
- Prometheus metrics at `/metrics`: off by default, turned on in `kalzit.toml` and readable only
  with a token or from allowed networks. They count requests, query times per source kind, query
  cache hits, active sessions and plugin processes, without names, addresses or query text
  ([guide](../../guide/monitoring.md)).

## Checklist for Windows (manual)

- Behind IIS with URL Rewrite (rule for `^kalzit/(.*)` to `http://127.0.0.1:3000/kalzit/{R:1}`) and
  `server.base_path = "/kalzit"` in `kalzit.toml`: after a restart of the service, `/kalzit/` signs
  in, a dashboard with live updates refreshes, and `/kalzit/healthz` answers `ok`.
