[English](../reverse-proxy.md) | Deutsch

# Hinter einem Reverse Proxy und unter einem Unterpfad

Kalzit läuft problemlos hinter nginx, Caddy, Traefik, IIS oder HAProxy. Was der Proxy senden muss,
welchen Adressen Kalzit vertraut und die Verbindungs-Timeouts stehen in
[HTTPS und Zertifikate](https.md#client-adresse-schema-und-host-hinter-einem-proxy). Diese Seite
ergänzt den **Unterpfad**: Kalzit unter `https://example.com/kalzit/` ausliefern statt unter einem
eigenen Host.

## Einstellungen

In `kalzit.toml` (oder der Umgebung):

```toml
[server]
public_url = "https://example.com"   # scheme and host only, no path
base_path = "/kalzit"                # KALZIT_SERVER_BASE_PATH

[security]
trusted_proxies = ["10.0.0.5/32"]    # the proxy's address
```

`base_path` beginnt mit `/`, hat ein oder mehrere Segmente aus Buchstaben, Ziffern, `-`, `_`, `.`
und `~` und keinen abschließenden Schrägstrich (`/kalzit/` wird als `/kalzit` gelesen; leer oder
`/` ist die Wurzel). Wie jede Netzwerkeinstellung wird er beim Start gelesen: **Starte Kalzit nach
einer Änderung neu.** Einstellungen > Netzwerk, HTTPS und Proxy zeigt ihn schreibgeschützt mit
seiner Quelle.

Mit einem Unterpfad:

- liegen jede Seite, jede API-Route, der Live-WebSocket (`/kalzit/api/orgs/<id>/live`), die Dateien
  der Weboberfläche, die Anmelde-Callbacks von OIDC und SAML (`/kalzit/auth/oidc/<slug>/callback`,
  `/kalzit/auth/saml/<slug>/acs`), SCIM (`/kalzit/scim/v2/...`) und `/kalzit/metrics` unterhalb des
  Präfixes;
- beginnen Links in Mails (Einladungen, Zurücksetzen des Passworts, Bestätigung der
  E-Mail-Adresse) und der Einrichtungslink mit `public_url` und dem Präfix;
- tragen Cookies `Path=/kalzit`. Über HTTPS heißen sie `__Secure-kalzit_*` statt
  `__Host-kalzit_*`, da Browser `__Host-`-Cookies nur mit `Path=/` annehmen;
- antworten `/healthz`, `/readyz` und die ACME-Challenge (`/.well-known/acme-challenge/`) auch an
  der Wurzel, für Prüfungen, die Kalzit direkt erreichen; `/` leitet auf `/kalzit/` um; alles andere
  außerhalb des Präfixes antwortet mit 404.

## Sicherheit: lieber ein eigener Hostname

Ein Unterpfad ist eine Bequemlichkeit, keine Grenze. Verwende ihn nur, wo du allem vertraust, was
sich den Host und seine übergeordnete Domain teilt; sonst gib Kalzit einen eigenen Hostnamen
(`https://kalzit.example.com`).

- **Jede Anwendung auf demselben Host teilt sich Kalzits Origin.** Der Cookie-Pfad trennt sie
  nicht: Eine Seite einer anderen Anwendung unter `https://example.com/other/` kann Kalzits API mit
  den Cookies der angemeldeten Person aufrufen und die Antworten lesen. Betreibe Kalzit nur dann
  unter einem Unterpfad, wenn jede Anwendung auf dem Host vertrauenswürdig ist.
- **Jeder Subdomain der übergeordneten Domain muss vertraut werden.** Anders als
  `__Host-`-Cookies dürfen `__Secure-`-Cookies für die ganze Domain gesetzt werden, daher könnte
  `https://other.example.com` ein Cookie mit dem Namen von Kalzits Cookie unterschieben. Kalzit
  lehnt einen Cookie-Namen ab, der doppelt ankommt (diese Anfrage hat dann keine Sitzung), aber
  eine Subdomain, die Cookies setzen kann, kann einen Browser trotzdem abmelden oder neu beginnen
  lassen.

Wenn du einen bestehenden Server auf einen Unterpfad umstellst, aktualisiere bei deinen
Identitätsanbietern die Redirect-URI (OIDC) sowie ACS und Entity-ID (SAML): Einstellungen >
Anmeldung zeigt die neuen Adressen. Alle melden sich einmal neu an, da ihre Cookies zur Wurzel
gehörten.

## Der Proxy behält das Präfix

Kalzit erwartet den vollständigen Pfad, Präfix eingeschlossen. Entferne es im Proxy nicht.

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

Traefik (Labels): `traefik.http.routers.kalzit.rule=Host(\`example.com\`) && PathPrefix(\`/kalzit\`)`
ohne eine `StripPrefix`-Middleware.

IIS mit URL Rewrite und ARR: eine Regel für `^kalzit/(.*)`, die auf
`http://127.0.0.1:3000/kalzit/{R:1}` umschreibt, mit eingeschalteter WebSocket-Unterstützung für
die Site.

## Prüfen

`curl -i https://example.com/kalzit/healthz` antwortet `ok`, und
`https://example.com/kalzit/` zeigt die Anmeldeseite. Bleibt die Seite leer, entfernt der Proxy
höchstwahrscheinlich das Präfix: Der Netzwerk-Tab des Browsers zeigt dann 404-Antworten für
`/kalzit/assets/...`.
