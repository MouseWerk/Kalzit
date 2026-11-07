[English](../monitoring.md) | Deutsch

# Überwachung

Kalzit beantwortet Health-Checks und, wenn du sie einschaltest, Prometheus-Metriken.

## Zustand

- `GET /healthz`: Der Prozess läuft (`ok`).
- `GET /readyz`: Die Datenbank antwortet, und der Server nimmt Anfragen an.

Beide brauchen keine Anmeldung und antworten auch auf dem HTTP-Port, wenn HTTPS an ist, sowie an
der Wurzel, wenn Kalzit unter einem Unterpfad läuft ([Reverse Proxy](reverse-proxy.md)).

## Prometheus-Metriken

`/metrics` liefert das Textformat von Prometheus. Es ist **standardmäßig aus** und nie für alle
offen: Zum Einschalten braucht es ein Token, erlaubte Netze oder beides (dann muss beides passen).

```toml
[metrics]
enabled = true                              # KALZIT_METRICS_ENABLED
allowed_networks = ["10.0.0.0/8"]           # KALZIT_METRICS_ALLOWED_NETWORKS
# token: give it in KALZIT_METRICS_TOKEN, not in this file
```

Das Token braucht mindestens 16 Zeichen, davon 8 verschiedene; erzeuge eines mit
`openssl rand -hex 32`.

Die Einstellungen werden beim Start gelesen; starte Kalzit nach einer Änderung neu.
Einstellungen > Allgemein zeigt sie schreibgeschützt. Ein Token in `kalzit.toml` funktioniert,
schreibt aber beim Start eine Warnung ins Log, da jeder, der die Datei lesen darf, es sieht; gib es
stattdessen in die Umgebung des Dienstes (systemd `Environment=` in einem Drop-in, das nur root
lesen kann, Docker Secrets als Umgebungsvariable, die Umgebung des Windows-Dienstes).

Hinter einem vertrauenswürdigen Proxy werden die erlaubten Netze mit der Client-Adresse
verglichen, die der Proxy weiterreicht
([HTTPS und Zertifikate](https.md#client-adresse-schema-und-host-hinter-einem-proxy)). Trage das Netz
eines Reverse Proxys nicht in `allowed_networks` ein, außer dieser Proxy steht in
`security.trusted_proxies`: Sonst kommt jede Anfrage, die er weiterreicht, von der Adresse des
Proxys, und jeder im Internet, der den Proxy erreicht, kann `/metrics` lesen. Dasselbe gilt für
Loopback (`127.0.0.1`, `::1`), wenn ein Proxy auf demselben Computer läuft. Kalzit schreibt beim
Start eine Warnung ins Log, wenn `allowed_networks` Loopback oder einen vertrauenswürdigen Proxy
abdeckt; nimm in solchen Aufbauten lieber das Token.
Antworten: `404`, solange Metriken aus sind, `403` aus einem anderen Netz, `401` ohne das richtige
Token.

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

### Was gemessen wird

| Metrik | Typ | Bedeutung |
|---|---|---|
| `kalzit_build_info{version}` | gauge | Die laufende Version |
| `process_start_time_seconds` | gauge | Start des Prozesses (Unix-Zeit) |
| `process_cpu_seconds_total` | counter | CPU-Zeit des Prozesses (Linux, Windows) |
| `process_resident_memory_bytes` | gauge | Speicher im RAM (Linux: Resident Set, Windows: Working Set) |
| `kalzit_http_requests_total{code}` | counter | Beantwortete Anfragen nach Statusklasse (`2xx`, `4xx`, ...) |
| `kalzit_http_requests_in_flight` | gauge | Anfragen, die gerade beantwortet werden |
| `kalzit_http_request_duration_seconds` | histogram | Zeit, um eine Anfrage zu beantworten |
| `kalzit_query_duration_seconds{kind,outcome}` | histogram | Abfragen an Datenquellen nach Art der Quelle (`postgres`, `neo4j`, die Art eines Plugins) und `ok`, `error` oder `timeout`; Antworten aus dem Cache zählen nicht mit |
| `kalzit_query_cache_hits_total`, `kalzit_query_cache_misses_total` | counter | Nachschlagen im Abfrage-Cache |
| `kalzit_query_cache_entries`, `kalzit_query_cache_bytes` | gauge | Was der Abfrage-Cache enthält |
| `kalzit_sessions_active` | gauge | Anmeldesitzungen, die nicht beendet sind |
| `kalzit_plugin_processes{state}` | gauge | Plugin-Prozesse nach Zustand (`running`, `waiting`, `stopped`, `idle`) |

Labels enthalten nie Benutzernamen, E-Mail- oder Client-Adressen, Abfragetext, IDs von Dashboards
oder Datenquellen oder Geheimnisse. Mit mehreren Servern auf einer Datenbank meldet jeder Server
seine eigenen Zahlen; `kalzit_sessions_active` zählt die Sitzungen aller Server.
