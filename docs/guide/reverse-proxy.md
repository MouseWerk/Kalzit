# Reverse proxy

Kalzit can serve HTTPS itself ([HTTPS and certificates](https.md)), but many installations put it
behind a reverse proxy that already holds the certificate. This page has working examples for
nginx, Caddy, IIS and Traefik, with Kalzit at the root of its own host name
(`https://kalzit.example.com/`).

## What every proxy must do

- **Pass WebSocket upgrades.** Live updates of dashboards and Explore are a WebSocket at
  `/api/orgs/<id>/live`. Without the upgrade, panels with Live on stay still.
- **Keep the host and say the scheme.** Send the host name the browser used (`Host`, or
  `X-Forwarded-Host`) and the scheme it used (`X-Forwarded-Proto: https`), and **overwrite** both
  when a client sends them. Kalzit checks the browser's `Origin` on changes and on the live
  WebSocket: with `server.public_url` set, the `Origin` must equal it (scheme, host and port);
  without it, the `Origin`'s host and port must match the forwarded host. Otherwise Kalzit
  refuses the request with "cross-origin request rejected". The scheme also decides whether the
  session cookie is marked `Secure`.
- **Say the client's address** in `X-Forwarded-For` (or `Forwarded`, see below), so sign-in limits,
  IP allow lists of API tokens and the audit log see the person, not the proxy.
- **Allow long requests and large uploads.** Live connections and streamed AI answers stay open;
  give them at least 10 minutes of idle time. Offline update packages are up to 512 MB and plugin
  packages up to 256 MB.
- **Close idle upstream connections before 75 seconds.** Kalzit closes a connection without a
  request after 75 seconds; a proxy that reuses a connection Kalzit is just closing answers 502.

On the Kalzit side, in `kalzit.toml`:

```toml
[server]
http_addr = "127.0.0.1:3000"                 # only the proxy on this machine reaches Kalzit
public_url = "https://kalzit.example.com"   # the address people open; links in mails use it

[security]
trusted_proxies = ["127.0.0.1/32", "::1/128"] # the proxy's address or network, nothing wider
# forwarded_headers = "forwarded"              # only when the proxy writes Forwarded (RFC 7239)
```

Kalzit reads forwarding headers only from addresses in `security.trusted_proxies`; keep that list
as narrow as the proxies you run. With the proxy on another machine, list its address and let
Kalzit listen on an address the proxy reaches, with a firewall that lets nobody else in. Leave
`server.https_addr` unset when the proxy terminates TLS. How Kalzit reads the headers, chains of
several proxies and `Forwarded` are described in
[HTTPS and certificates](https.md#client-address-scheme-and-host-behind-a-proxy).

## nginx

```nginx
upstream kalzit {
    server 127.0.0.1:3000;
    keepalive 16;
    keepalive_timeout 60s;           # below Kalzit's 75 seconds
}

map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      '';
}

server {
    listen 443 ssl;
    http2 on;
    server_name kalzit.example.com;
    ssl_certificate     /etc/ssl/kalzit/fullchain.pem;
    ssl_certificate_key /etc/ssl/kalzit/privkey.pem;

    client_max_body_size 600m;       # offline update packages and plugin files

    location / {
        proxy_pass http://kalzit;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_read_timeout 600s;     # live updates and streamed AI answers
        proxy_send_timeout 600s;
    }
}

server {
    listen 80;
    server_name kalzit.example.com;
    return 301 https://$host$request_uri;
}
```

`proxy_set_header` replaces what a client sent. Streamed AI answers carry `X-Accel-Buffering: no`,
so nginx passes them on at once without turning buffering off for everything else.

## Caddy

```caddyfile
kalzit.example.com {
    request_body {
        max_size 600MB
    }
    reverse_proxy 127.0.0.1:3000 {
        transport http {
            keepalive 60s
        }
    }
}
```

Caddy gets the certificate itself, passes WebSocket upgrades, sets `X-Forwarded-For`,
`X-Forwarded-Proto` and `X-Forwarded-Host` and keeps the `Host` header. Without `trusted_proxies`
in Caddy's own settings it replaces those headers when a client sends them, which is what Kalzit
needs. Caddy does not cut long-lived connections by default.

## Traefik

With the file provider (`traefik.yml` for the static part, a dynamic file for the rest):

```yaml
# traefik.yml (static)
entryPoints:
  websecure:
    address: ":443"
    transport:
      respondingTimeouts:
        readTimeout: 0s              # no limit for uploads and live connections
certificatesResolvers:
  letsencrypt:
    acme:
      email: admin@example.com
      storage: /etc/traefik/acme.json
      tlsChallenge: {}
providers:
  file:
    filename: /etc/traefik/kalzit.yml
```

```yaml
# kalzit.yml (dynamic)
http:
  routers:
    kalzit:
      rule: "Host(`kalzit.example.com`)"
      entryPoints: [websecure]
      service: kalzit
      tls:
        certResolver: letsencrypt
  services:
    kalzit:
      loadBalancer:
        passHostHeader: true
        serversTransport: kalzit
        servers:
          - url: "http://127.0.0.1:3000"
  serversTransports:
    kalzit:
      forwardingTimeouts:
        idleConnTimeout: 60s         # below Kalzit's 75 seconds
```

Traefik passes WebSocket upgrades on its own and sets `X-Forwarded-For`, `X-Forwarded-Proto` and
`X-Forwarded-Host`; it drops those headers from clients unless you list them under
`forwardedHeaders.trustedIPs` of the entry point, so leave that list empty for an entry point the
public reaches. In Docker with labels, the same router and service are
``traefik.http.routers.kalzit.rule=Host(`kalzit.example.com`)``,
`traefik.http.routers.kalzit.tls.certresolver=letsencrypt`,
`traefik.http.services.kalzit.loadbalancer.server.port=3000` and
`traefik.http.services.kalzit.loadbalancer.serverstransport=kalzit@file`; keep the
`serversTransports` part of the dynamic file above for that last label, so idle connections are
closed before Kalzit's 75 seconds. Kalzit must then listen on all addresses of its container
(`server.http_addr = "0.0.0.0:3000"`, the default), and `security.trusted_proxies` lists the Docker
network Traefik reaches it through.

## IIS

IIS forwards with the **URL Rewrite** and **Application Request Routing** (ARR) modules. Install
both, and the Windows feature **WebSocket Protocol** (Server Manager, Web Server (IIS) > Web
Server > Application Development). Then, once per server:

1. IIS Manager > the server > **Application Request Routing Cache** > **Server Proxy Settings**:
   tick **Enable proxy**, set **Time-out** to 600 seconds, untick **Reverse rewrite host in
   response headers**, set **Response buffer threshold** to 0 so streamed AI answers arrive
   piece by piece, and apply.
2. Keep the host name: in an elevated prompt,
   `%windir%\system32\inetsrv\appcmd.exe set config -section:system.webServer/proxy -preserveHostHeader:true /commit:apphost`.
3. Allow the rewrite rule to set the forwarding headers: IIS Manager > the server > **URL
   Rewrite** > **View Server Variables** > add `HTTP_X_FORWARDED_PROTO` and
   `HTTP_X_FORWARDED_HOST`.
4. ARR has no setting for how long it keeps an idle connection to Kalzit open, so it may reuse one
   Kalzit is just closing after 75 seconds and answer 502. Untick **Keep alive** in **Server Proxy
   Settings** (or
   `%windir%\system32\inetsrv\appcmd.exe set config -section:system.webServer/proxy -keepAlive:false /commit:apphost`):
   each request then opens its own connection, which costs little with Kalzit on the same
   machine.

The site for `kalzit.example.com` holds the certificate (HTTPS binding) and this `web.config`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<configuration>
  <system.webServer>
    <rewrite>
      <rules>
        <rule name="Kalzit" stopProcessing="true">
          <match url="(.*)" />
          <serverVariables>
            <set name="HTTP_X_FORWARDED_PROTO" value="https" />
            <set name="HTTP_X_FORWARDED_HOST" value="{HTTP_HOST}" />
          </serverVariables>
          <action type="Rewrite" url="http://127.0.0.1:3000/{R:1}" />
        </rule>
      </rules>
    </rewrite>
    <security>
      <requestFiltering>
        <!-- offline update packages and plugin files, in bytes -->
        <requestLimits maxAllowedContentLength="629145600" />
      </requestFiltering>
    </security>
  </system.webServer>
</configuration>
```

ARR adds the client's address with its port to `X-Forwarded-For` (`203.0.113.5:51234`); Kalzit
reads that form. It does not remove an `X-Forwarded-For` a client sent but appends to it, which
Kalzit handles by reading the list from the right. The rule above overwrites
`X-Forwarded-Proto` and `X-Forwarded-Host`, so a client cannot choose them.

## Checking the setup

- Open `https://kalzit.example.com`, sign in, and open a dashboard with **Live** on: the panels
  update without a reload. In the browser's developer tools the request to `/api/orgs/.../live`
  answers `101 Switching Protocols`.
- Settings > Sign-in and security lists your sign-in under recent sign-ins with your own
  address, not the proxy's.
- Saving a setting works. "Cross-origin request rejected" means `server.public_url` does not
  match the address in the browser (scheme, host and port), or, without `server.public_url`, the
  proxy does not pass the host the browser used.
- `curl -s https://kalzit.example.com/readyz` answers `ready` (status 200) while Kalzit reaches
  its database; use it for the proxy's health check.

## Under a sub-path

Kalzit under a path of a shared host name (`https://example.com/kalzit/`) needs the sub-path
setting, which comes in M6 together with this section. Until then, give Kalzit a host name of its
own as above.
