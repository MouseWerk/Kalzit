# Behind a reverse proxy and under a sub-path

Kalzit runs fine behind nginx, Caddy, Traefik, IIS or HAProxy. What the proxy must send, which
addresses Kalzit trusts and the connection timeouts are in
[HTTPS and certificates](https.md#client-address-scheme-and-host-behind-a-proxy). This page adds
the **sub-path**: serving Kalzit at `https://example.com/kalzit/` instead of a host of its own.

## Settings

In `kalzit.toml` (or the environment):

```toml
[server]
public_url = "https://example.com"   # scheme and host only, no path
base_path = "/kalzit"                # KALZIT_SERVER_BASE_PATH

[security]
trusted_proxies = ["10.0.0.5/32"]    # the proxy's address
```

`base_path` starts with `/`, has one or more segments of letters, digits, `-`, `_`, `.` and `~`,
and no trailing slash (`/kalzit/` is read as `/kalzit`; empty or `/` is the root). Like every
network setting it is read at start: **restart Kalzit after changing it**. Settings > Network
shows it read-only with its source.

With a sub-path:

- every page, API route, the live WebSocket (`/kalzit/api/orgs/<id>/live`), the web UI's files, the sign-in
  callbacks of OIDC and SAML (`/kalzit/auth/oidc/<slug>/callback`, `/kalzit/auth/saml/<slug>/acs`),
  SCIM (`/kalzit/scim/v2/...`) and `/kalzit/metrics` live below the prefix;
- links in mails (invitations, password resets, email confirmation) and the setup link start with
  `public_url` and the prefix;
- cookies carry `Path=/kalzit`. Over HTTPS they are named `__Secure-kalzit_*` instead of
  `__Host-kalzit_*` (browsers accept `__Host-` cookies only with `Path=/`), so another application
  on the same host does not receive them;
- `/healthz`, `/readyz` and the ACME challenge (`/.well-known/acme-challenge/`) answer at the root
  as well, for probes that reach Kalzit directly; `/` redirects to `/kalzit/`; everything else
  outside the prefix answers 404.

When you switch an existing server to a sub-path, update the redirect URI (OIDC) and the ACS and
entity ID (SAML) at your identity providers: Settings > Sign-in shows the new addresses. People
sign in again once, since their cookies belonged to the root.

## The proxy keeps the prefix

Kalzit expects the full path, prefix included. Do not strip it in the proxy.

nginx:

```nginx
location /kalzit/ {
    proxy_pass http://127.0.0.1:3000;          # no path after the port: the prefix stays
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;    # live updates (WebSocket)
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 3600s;                  # long-lived live connections
}
```

Caddy:

```caddy
example.com {
    handle /kalzit/* {
        reverse_proxy 127.0.0.1:3000
    }
}
```

Traefik (labels): `traefik.http.routers.kalzit.rule=Host(\`example.com\`) && PathPrefix(\`/kalzit\`)`
without a `StripPrefix` middleware.

IIS with URL Rewrite and ARR: a rule for `^kalzit/(.*)` that rewrites to
`http://127.0.0.1:3000/kalzit/{R:1}`, with WebSocket support turned on for the site.

## Checking it

`curl -i https://example.com/kalzit/healthz` answers `ok`, and
`https://example.com/kalzit/` shows the sign-in page. If the page stays blank, the proxy most likely
strips the prefix: the browser's network tab then shows 404 answers for `/kalzit/assets/...`.
