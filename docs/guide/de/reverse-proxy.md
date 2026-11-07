[English](../reverse-proxy.md) | Deutsch

# Reverse Proxy

Kalzit kann HTTPS selbst ausliefern ([HTTPS und Zertifikate](https.md)), aber viele Installationen
stellen es hinter einen Reverse Proxy, der das Zertifikat schon hat. Diese Seite zeigt
funktionierende Beispiele für nginx, Caddy, IIS und Traefik, zuerst mit Kalzit an der Wurzel eines
eigenen Hostnamens (`https://kalzit.example.com/`), danach [unter einem Unterpfad](#unter-einem-unterpfad)
wie `https://example.com/kalzit/`.

## Was jeder Proxy tun muss

- **WebSocket-Upgrades weitergeben.** Live-Aktualisierungen von Dashboards und Explore laufen über
  einen WebSocket unter `/api/orgs/<id>/live`. Ohne das Upgrade bleiben Panels mit eingeschaltetem
  Live stehen.
- **Den Host behalten und das Schema nennen.** Sende den Hostnamen, den der Browser verwendet hat
  (`Host` oder `X-Forwarded-Host`), und das Schema, das er verwendet hat (`X-Forwarded-Proto: https`),
  und **überschreibe** beide, wenn ein Client sie mitschickt. Kalzit prüft bei Änderungen und beim
  Live-WebSocket den `Origin` des Browsers: Ist `server.public_url` gesetzt, muss der `Origin` genau
  ihr entsprechen (Schema, Host und Port); ohne sie müssen Host und Port des `Origin` zum
  weitergeleiteten Host passen. Sonst lehnt Kalzit die Anfrage mit „cross-origin request rejected“
  ab. Das Schema entscheidet außerdem, ob das Sitzungscookie als `Secure` markiert wird.
- **Die Adresse des Clients nennen**, in `X-Forwarded-For` (oder `Forwarded`, siehe unten), damit
  Anmeldegrenzen, IP-Freigabelisten von API-Tokens und das Audit-Log die Person sehen, nicht den
  Proxy.
- **Lange Anfragen und große Uploads erlauben.** Live-Verbindungen und gestreamte KI-Antworten
  bleiben offen; gib ihnen mindestens 10 Minuten Leerlaufzeit. Offline-Updatepakete sind bis zu
  512 MB groß, Plugin-Pakete bis zu 256 MB.
- **Leerlaufende Verbindungen zu Kalzit vor 75 Sekunden schließen.** Kalzit schließt eine
  Verbindung ohne Anfrage nach 75 Sekunden; ein Proxy, der eine Verbindung wiederverwendet, die
  Kalzit gerade schließt, antwortet mit 502.

Auf der Seite von Kalzit, in `kalzit.toml`:

```toml
[server]
http_addr = "127.0.0.1:3000"                 # only the proxy on this machine reaches Kalzit
public_url = "https://kalzit.example.com"   # the address people open; links in mails use it

[security]
trusted_proxies = ["127.0.0.1/32", "::1/128"] # the proxy's address or network, nothing wider
# forwarded_headers = "forwarded"              # only when the proxy writes Forwarded (RFC 7239)
```

Kalzit liest Weiterleitungs-Header nur von Adressen in `security.trusted_proxies`; halte diese Liste
so eng wie die Proxys, die du betreibst. Läuft der Proxy auf einem anderen Computer, trage dessen
Adresse ein und lass Kalzit auf einer Adresse lauschen, die der Proxy erreicht, mit einer Firewall,
die sonst niemanden hereinlässt. Lass `server.https_addr` ungesetzt, wenn der Proxy TLS beendet.
Wie Kalzit die Header liest, Ketten aus mehreren Proxys und `Forwarded` beschreibt
[HTTPS und Zertifikate](https.md#client-adresse-schema-und-host-hinter-einem-proxy).

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

`proxy_set_header` ersetzt, was ein Client geschickt hat. Gestreamte KI-Antworten tragen
`X-Accel-Buffering: no`, sodass nginx sie sofort weitergibt, ohne die Pufferung für alles andere
abzuschalten.

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

Caddy holt das Zertifikat selbst, gibt WebSocket-Upgrades weiter, setzt `X-Forwarded-For`,
`X-Forwarded-Proto` und `X-Forwarded-Host` und behält den `Host`-Header. Ohne `trusted_proxies` in
Caddys eigenen Einstellungen ersetzt es diese Header, wenn ein Client sie schickt, und genau das
braucht Kalzit. Caddy trennt langlebige Verbindungen standardmäßig nicht.

## Traefik

Mit der Konfiguration aus Dateien (`providers.file`; `traefik.yml` für den statischen Teil, eine dynamische Datei für den Rest):

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

Traefik gibt WebSocket-Upgrades von sich aus weiter und setzt `X-Forwarded-For`,
`X-Forwarded-Proto` und `X-Forwarded-Host`; diese Header von Clients verwirft es, außer du trägst
sie unter `forwardedHeaders.trustedIPs` des Entry Points ein. Lass diese Liste also leer für einen
Entry Point, den die Öffentlichkeit erreicht. In Docker mit Labels sind derselbe Router und Dienst
``traefik.http.routers.kalzit.rule=Host(`kalzit.example.com`)``,
`traefik.http.routers.kalzit.tls.certresolver=letsencrypt`,
`traefik.http.services.kalzit.loadbalancer.server.port=3000` und
`traefik.http.services.kalzit.loadbalancer.serverstransport=kalzit@file`; behalte für das letzte
Label den Teil `serversTransports` der dynamischen Datei oben, damit leerlaufende Verbindungen vor
den 75 Sekunden von Kalzit geschlossen werden. Kalzit muss dann auf allen Adressen seines
Containers lauschen (`server.http_addr = "0.0.0.0:3000"`, der Standard), und
`security.trusted_proxies` nennt das Docker-Netzwerk, über das Traefik es erreicht.

## IIS

IIS leitet mit den Modulen **URL Rewrite** und **Application Request Routing** (ARR) weiter.
Installiere beide und das Windows-Feature **WebSocket Protocol** (Server-Manager, Web Server (IIS) >
Web Server > Application Development). Dann einmal pro Server:

1. IIS-Manager > der Server > **Application Request Routing Cache** > **Server Proxy Settings**:
   Hake **Enable proxy** an, setze **Time-out** auf 600 Sekunden, nimm den Haken bei **Reverse
   rewrite host in response headers** heraus, setze **Response buffer threshold** auf 0, damit
   gestreamte KI-Antworten Stück für Stück ankommen, und übernimm die Einstellungen.
2. Den Hostnamen behalten: in einer Eingabeaufforderung mit Administratorrechten
   `%windir%\system32\inetsrv\appcmd.exe set config -section:system.webServer/proxy -preserveHostHeader:true /commit:apphost`.
3. Der Rewrite-Regel erlauben, die Weiterleitungs-Header zu setzen: IIS-Manager > der Server >
   **URL Rewrite** > **View Server Variables** > `HTTP_X_FORWARDED_PROTO` und
   `HTTP_X_FORWARDED_HOST` hinzufügen.
4. ARR hat keine Einstellung dafür, wie lange es eine leerlaufende Verbindung zu Kalzit offen hält;
   es kann also eine wiederverwenden, die Kalzit nach 75 Sekunden gerade schließt, und mit 502
   antworten. Nimm in **Server Proxy Settings** den Haken bei **Keep alive** heraus (oder
   `%windir%\system32\inetsrv\appcmd.exe set config -section:system.webServer/proxy -keepAlive:false /commit:apphost`):
   Jede Anfrage öffnet dann ihre eigene Verbindung, was wenig kostet, wenn Kalzit auf demselben
   Computer läuft.

Die Site für `kalzit.example.com` hält das Zertifikat (HTTPS-Bindung) und diese `web.config`:

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

ARR hängt die Adresse des Clients mit ihrem Port an `X-Forwarded-For` an (`203.0.113.5:51234`);
Kalzit liest diese Form. Ein `X-Forwarded-For`, das ein Client geschickt hat, entfernt ARR nicht,
sondern hängt daran an; Kalzit kommt damit zurecht, weil es die Liste von rechts liest. Die Regel
oben überschreibt `X-Forwarded-Proto` und `X-Forwarded-Host`, sodass ein Client sie nicht wählen
kann.

## Die Einrichtung prüfen

- Öffne `https://kalzit.example.com`, melde dich an und öffne ein Dashboard mit eingeschaltetem
  **Live**: Die Panels aktualisieren sich ohne Neuladen. In den Entwicklertools des Browsers
  antwortet die Anfrage an `/api/orgs/.../live` mit `101 Switching Protocols`.
- Einstellungen > Anmeldung und Sicherheit führt deine Anmeldung unter den letzten Anmeldungen mit
  deiner eigenen Adresse, nicht mit der des Proxys.
- Eine Einstellung zu speichern funktioniert. „Cross-origin request rejected“ heißt, dass
  `server.public_url` nicht zur Adresse im Browser passt (Schema, Host und Port) oder dass der
  Proxy ohne `server.public_url` den Host nicht weitergibt, den der Browser verwendet hat.
- `curl -s https://kalzit.example.com/readyz` antwortet mit `ready` (Status 200), solange Kalzit
  seine Datenbank erreicht; nutze das für den Health-Check des Proxys.

## Unter einem Unterpfad

Kalzit lässt sich auch unter einem Pfad eines geteilten Hosts ausliefern, `https://example.com/kalzit/`
statt unter einem eigenen Host. Alles oben gilt weiterhin; dieser Abschnitt ergänzt die Einstellung
und was sich ändert.

### Einstellungen

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

- liegen alle Seiten, API-Routen, der Live-WebSocket (`/kalzit/api/orgs/<id>/live`), die Dateien der
  Weboberfläche, die Anmelde-Callbacks von OIDC und SAML (`/kalzit/auth/oidc/<slug>/callback`,
  `/kalzit/auth/saml/<slug>/acs`), SCIM (`/kalzit/scim/v2/...`) und `/kalzit/metrics` unter dem
  Präfix;
- beginnen Links in Mails (Einladungen, Passwort zurücksetzen, Bestätigung der E-Mail-Adresse) und
  der Einrichtungslink mit `public_url` und dem Präfix;
- tragen Cookies `Path=/kalzit`. Über HTTPS heißen sie `__Secure-kalzit_*` statt `__Host-kalzit_*`,
  da Browser `__Host-`-Cookies nur mit `Path=/` annehmen;
- antworten `/healthz`, `/readyz` und die ACME-Challenge (`/.well-known/acme-challenge/`) auch an
  der Wurzel, für Prüfungen, die Kalzit direkt erreichen; `/` leitet auf `/kalzit/` weiter; alles
  andere außerhalb des Präfixes antwortet mit 404.

### Sicherheit: besser ein eigener Hostname

Ein Unterpfad ist eine Bequemlichkeit, keine Grenze. Nutze ihn nur, wo du allem vertraust, was sich
den Host und seine übergeordnete Domain teilt; sonst gib Kalzit einen eigenen Hostnamen
(`https://kalzit.example.com`).

- **Jede Anwendung auf demselben Host teilt sich den Origin von Kalzit.** Der Cookie-Pfad trennt
  sie nicht: Eine Seite einer anderen Anwendung unter `https://example.com/other/` kann die API von
  Kalzit mit den Cookies der angemeldeten Person aufrufen und die Antworten lesen. Betreibe Kalzit
  nur auf einem Host unter einem Unterpfad, auf dem jeder Anwendung vertraut wird.
- **Jeder Subdomain der übergeordneten Domain muss vertraut werden.** Anders als `__Host-`-Cookies
  dürfen `__Secure-`-Cookies für die ganze Domain gesetzt werden, sodass `https://other.example.com`
  ein Cookie unterschieben könnte, das wie eines von Kalzit heißt. Kalzit lehnt einen Cookie-Namen
  ab, der doppelt ankommt (diese Anfrage hat dann keine Sitzung), aber eine Subdomain, die Cookies
  setzen kann, kann einen Browser trotzdem abmelden oder von vorn beginnen lassen.

Wenn du einen bestehenden Server auf einen Unterpfad umstellst, aktualisiere bei deinen
Identitätsanbietern die Redirect-URI (OIDC) sowie ACS und Entity-ID (SAML): Einstellungen >
Anmeldung zeigt die neuen Adressen. Alle melden sich einmal neu an, da ihre Cookies zur Wurzel
gehörten.

### Der Proxy behält das Präfix

Kalzit erwartet den vollen Pfad, Präfix eingeschlossen. Entferne es nicht im Proxy.

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
`http://127.0.0.1:3000/kalzit/{R:1}` umschreibt, mit eingeschalteter WebSocket-Unterstützung für die
Site.

### Prüfen

`curl -i https://example.com/kalzit/healthz` antwortet mit `ok`, und
`https://example.com/kalzit/` zeigt die Anmeldeseite. Bleibt die Seite leer, entfernt der Proxy
höchstwahrscheinlich das Präfix: Der Netzwerk-Tab des Browsers zeigt dann 404-Antworten für
`/kalzit/assets/...`.
