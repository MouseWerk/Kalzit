[English](../https.md) | Deutsch

# HTTPS und Zertifikate

Kalzit liefert HTTPS selbst aus (TLS 1.2 und 1.3, HTTP/2), wenn `server.https_addr` in
`kalzit.toml` oder `KALZIT_SERVER_HTTPS_ADDR` gesetzt ist. Das Zertifikat kommt aus einer von zwei
Quellen:

- **deine eigenen Dateien**: `tls.cert_file` und `tls.key_file` (PEM). Kalzit lädt sie neu, wenn
  sich ihr Inhalt ändert, ohne Neustart (`tls.reload_interval_secs`). Es vergleicht den Inhalt,
  nicht die Änderungszeit, daher wird eine erneuerte Datei, die die alte Zeit behält, oder eine
  Kopie mit älterer Zeit übernommen, und eine Datei, die mit gleichem Inhalt neu geschrieben wurde,
  wird nicht noch einmal geladen;
- **ACME**: Ohne Zertifikatsdateien bestellt Kalzit das Zertifikat selbst bei Let's Encrypt oder
  einer anderen Zertifizierungsstelle, die ACME anbietet, und erneuert es. Bis das erste
  ausgestellt ist, liefert HTTPS ein vorläufiges selbstsigniertes Zertifikat aus, vor dem Browser
  warnen.

HTTPS ohne Zertifikatsdateien startet nur, wenn ACME an ist: Sonst verweigert Kalzit den Start und
sagt, welche Dateien fehlen, damit eine vertippte Konfiguration nie dauerhaft ein selbstsigniertes
Zertifikat ausliefert. Um einen bestehenden Server auf ACME umzustellen, schalte ACME mit HTTP-01
ein, solange HTTPS noch aus ist (Kalzit bestellt und speichert das Zertifikat über HTTP), setze
dann `server.https_addr` und starte neu: HTTPS startet mit dem gespeicherten Zertifikat.

Hinter einem Reverse Proxy, der TLS terminiert (nginx, Caddy, Traefik, IIS), braucht Kalzit keins
von beiden: Der Proxy hält das Zertifikat.

Kalzit schließt eine Verbindung ohne laufende Anfrage nach 75 Sekunden. Ein Proxy, der
Verbindungen zu Kalzit zur Wiederverwendung offen hält, sollte ungenutzte früher schließen, sonst
schickt er womöglich eine Anfrage in eine Verbindung, die Kalzit gerade schließt, und antwortet mit
502. Der Standard von nginx (`keepalive_timeout 60s` in einem `upstream`-Block) passt; bei Caddy,
Traefik und anderen setze das Idle- oder Keep-Alive-Timeout zum Upstream unter 75 Sekunden
(Beispiele unter [Reverse Proxy](reverse-proxy.md)). Trage die
Adresse des Proxys in `security.trusted_proxies` ein: Dann gilt für ihn nicht das Limit von 256
Verbindungen pro Client-Adresse, das sich sonst alle seine Verbindungen teilen würden.

### Client-Adresse, Schema und Host hinter einem Proxy

Kalzit liest, was ein Proxy über die ursprüngliche Anfrage sagt, nur, wenn die Verbindung von einer
Adresse in `security.trusted_proxies` kommt; von allen anderen werden diese Header ignoriert.
Welchen Header es liest, wählst du in `security.forwarded_headers` (`kalzit.toml` oder
`KALZIT_SECURITY_FORWARDED_HEADERS`), und es liest nur diesen einen:

- `x-forwarded` (der Standard): `X-Forwarded-For`, `X-Forwarded-Proto` und `X-Forwarded-Host`.
  `Forwarded` wird vollständig ignoriert.
- `forwarded`: der Standard-Header `Forwarded` (RFC 7239). Die `X-Forwarded-*`-Header werden
  vollständig ignoriert.

Setze den, den dein Proxy schreibt, und stelle sicher, dass der Proxy **diesen Header ersetzt oder
entfernt, wenn ein Client ihn mitschickt**. Die meisten Proxys (nginx, IIS ARR, Traefik, HAProxy)
reichen Header, die sie nicht schreiben, unverändert durch, und viele hängen an einen
Weiterleitungs-Header an, statt ihn zu ersetzen. Kalzit kommt mit dem Anhängen zurecht (siehe
unten), aber einen Header, den der Proxy weder schreibt noch entfernt, darf der Client füllen: Mit
der falschen Einstellung könnte ein Client seine eigene Adresse wählen, auf die sich
Anmeldelimits, IP-Zulassungslisten und das Audit-Log verlassen.

- **Mehrere Proxys.** Kalzit liest die Liste von rechts: Jeder Eintrag zählt, solange der Proxy,
  der ihn geschrieben hat, vertrauenswürdig ist. Der Client ist die erste Adresse, die nicht in
  `security.trusted_proxies` steht; Einträge, die ein Client davorgesetzt hat, werden nie gelesen.
  Mit `Forwarded` kommen Schema und Host aus dem Element der ersten nicht vertrauenswürdigen
  Adresse. Bei `X-Forwarded-Proto` und `X-Forwarded-Host` zählt nur der letzte Wert, den der Proxy
  direkt vor Kalzit gesetzt hat; Werte davor werden nie Adressen zugeordnet, weil ein Proxy, der an
  `X-Forwarded-For` anhängt, aber nicht an diese Header, sonst die eigenen Werte eines Clients
  passend einreihen ließe. Liste jeden deiner Proxys in der Kette auf.
- **`X-Forwarded-Proto` und `X-Forwarded-Host`.** Der Proxy direkt vor Kalzit **muss beide Header
  bei jeder Anfrage setzen und überschreiben**, was der Client geschickt hat, mit dem Schema und
  dem Host, die der Client verwendet hat (nginx: `proxy_set_header X-Forwarded-Proto $scheme;` und
  `proxy_set_header X-Forwarded-Host $host;`), statt sie durchzureichen. Statt `X-Forwarded-Host`
  zu setzen, darf der Proxy den Header auch entfernen und den `Host`-Header unverändert
  durchreichen. Kalzit glaubt einem
  vertrauenswürdigen Proxy beides: Das Schema entscheidet, ob Sitzungs-Cookies als `Secure`
  markiert werden und ob die Anfrage als HTTPS zählt; der Host wird für die Cross-Origin-Prüfung
  verwendet, wenn `server.public_url` nicht gesetzt ist, für Links in Mails und für
  Weiterleitungen beim Anmelden. Sieh in der Dokumentation deines Proxys nach; einer, der einen
  Header nur hinzufügt, wenn er fehlt, reicht nicht. Ein Proxy, der den Header eines Clients
  unverändert durchreicht, lässt den Client HTTPS oder einen anderen Host behaupten. Ein
  weitergeleiteter Host, der kein schlichtes `host` oder `host:port` ist, wird ignoriert, und
  stattdessen zählt der `Host`-Header.
- **`Forwarded`-Werte.** Werte in Anführungszeichen, Ports (`for="203.0.113.5:4711"`,
  `for="[2001:db8::7]:443"`) und mehrere Headerzeilen werden verstanden. Eine Anfrage ohne den
  Header zählt als die des Proxys selbst (ein Health-Check). Eine Anfrage, deren Header zu keiner
  Client-Adresse führt, wird mit `400` und einer Warnung im Log abgelehnt (einmal pro Minute und
  Proxy, mit der Zahl der abgelehnten Anfragen): ein Eintrag eines vertrauenswürdigen Proxys, der
  sich nicht parsen lässt, kein `for` hat oder keine Adresse nennt (`for=unknown`, ein
  verschleierter Name wie `for=_proxy1`). Als Proxy gezählt, würde sie sich die Anmelde- und
  Ratenlimits mit allen dahinter teilen.

Beispiel für nginx mit `security.forwarded_headers = "forwarded"`, das ersetzt, was der Client
geschickt hat: `proxy_set_header Forwarded "for=\"$remote_addr\";proto=$scheme;host=$host";`. Mit
dem Standard ersetzt `proxy_set_header X-Forwarded-For $remote_addr;` den Wert des Clients
(`$proxy_add_x_forwarded_for` hängt an ihn an, was ebenfalls funktioniert).

## Bevor du ACME einschaltest

1. **Namen im DNS.** Jeder Name, für den das Zertifikat gilt, muss aus dem Internet (bei einer
   internen CA: von der CA aus) zu diesem Server auflösen.
2. **Listener.** In `kalzit.toml`:

   ```toml
   [server]
   http_addr = "0.0.0.0:80"
   https_addr = "0.0.0.0:443"
   public_url = "https://kalzit.example.com"
   ```

   Ports unter 1024 brauchen das Recht, sie zu belegen; der Dienst aus dem deb- und rpm-Paket hat
   es ([Installation](installation.md#debian-ubuntu-fedora-rhel-deb-und-rpm)). Hinter einem Router
   oder einer Port-Zuordnung eines Containers leite 80 und 443 von außen an die Ports weiter, auf
   denen Kalzit lauscht.
3. **Keine Zertifikatsdateien.** `tls.cert_file` und `tls.key_file` dürfen nicht gesetzt sein;
   Dateien gewinnen immer.

## Einrichten

Öffne als Server-Admin **Einstellungen** > **Netzwerk, HTTPS und Proxy**. Unter den Adressen stehen
zwei Karten: das verwendete Zertifikat und **Automatische Zertifikate (ACME)**. Die Felder hängen
voneinander ab, daher gelten sie erst mit **Speichern**, nie einzeln:

| Feld | Was es tut |
|---|---|
| Zertifikate automatisch bestellen | Schaltet ACME ein oder aus. Ausgeschaltet bleibt das letzte Zertifikat in Gebrauch, bis es abläuft |
| Zertifizierungsstelle | **Let’s Encrypt**; **Let’s Encrypt (Test)** zum Ausprobieren der Einrichtung, mit großzügigen Limits, aber Zertifikaten, denen kein Browser vertraut; oder **Andere** |
| ACME-Adresse | Nur für Andere: die `https://`-Adresse des ACME-Verzeichnisses der CA, zum Beispiel `https://ca.internal.example/acme/acme/directory` für step-ca |
| CA-Zertifikat | Nur für Andere, optional: das PEM-Zertifikat einer internen CA, dem für diese Adresse zusätzlich zu den Zertifikaten des Systems vertraut wird |
| Namen | Einer pro Zeile, bis zu 100. Wildcards (`*.example.com`) brauchen eine DNS-Prüfung, die Kalzit nicht anbietet |
| Kontakt-E-Mail | Optional; die CA schreibt hierhin, bevor ein Zertifikat abläuft oder wenn etwas nicht stimmt |
| Prüfung | **HTTP-01**: Die CA holt ein Token von `http://<name>/.well-known/acme-challenge/` auf Port 80, beantwortet von Kalzits HTTP-Listener, auch wenn er alles andere auf HTTPS umleitet. **TLS-ALPN-01**: Die CA verbindet sich mit Port 443, und Kalzits HTTPS-Listener antwortet; Port 80 ist nicht nötig |
| Nutzungsbedingungen akzeptieren | Pflicht: Die CA stellt Zertifikate nur aus, wenn ihre Bedingungen akzeptiert sind |

**Verbindung testen** prüft, ohne zu speichern: Die ACME-Adresse antwortet als ACME-Verzeichnis,
jeder Name löst auf, und es verlinkt die Bedingungen der CA. Es warnt, wenn der Listener der
gewählten Prüfung nicht auf dem Port liegt, mit dem sich die CA verbindet (80 oder 443), was in
Ordnung ist, wenn ein Router diesen Port weiterleitet. **Speichern** führt dieselben Prüfungen aus;
das erste Problem erscheint an seinem Feld. Beginne mit **Let’s Encrypt (Test)**, bis ein
Zertifikat ausgestellt ist, und wechsle dann zu Let’s Encrypt: Die Limits der Testumgebung sind viel
höher, und ein fehlgeschlagener Versuch zählt nicht gegen die Limits der Produktivumgebung.

## Bestellung und Erneuerung

Nach dem Speichern bestellt Kalzit im Hintergrund ein Zertifikat, wenn keines zu den Einstellungen
passt (andere Namen, andere CA). Die Karte **HTTPS-Zertifikat** zeigt seinen Zustand, die Namen,
den Aussteller, bis wann es gültig ist und wann es erneuert wird. Das neue Zertifikat wird ab der
nächsten Verbindung ausgeliefert, ohne Neustart.

Kalzit erneuert, sobald zwei Drittel der Laufzeit vergangen sind: 30 Tage vor dem Ende eines
90-Tage-Zertifikats. Ein fehlgeschlagener Versuch wird nach 5 Minuten wiederholt, dann nach 15
Minuten, 1, 3 und 6 Stunden, danach alle 12 Stunden, sodass die Ratenlimits der CA eingehalten
werden; die Karte zeigt den Grund und den nächsten Versuch. **Jetzt erneuern** bestellt sofort, zum
Beispiel nachdem das Zertifikat widerrufen wurde. Es wird abgelehnt während der Pause nach einem
fehlgeschlagenen Versuch (ändere die Einstellungen, um es früher erneut zu versuchen) und solange
das verwendete Zertifikat jünger als ein Drittel seiner Laufzeit ist und zu den Einstellungen
passt, weil jedes Zertifikat gegen die Limits der CA zählt. Ein Zertifikat, das ausgestellt, aber
nicht gespeichert werden konnte, bleibt in Gebrauch, die Karte zeigt warum, und das Speichern wird
nach einer Pause erneut versucht; die Erneuerung geht weiter, wenn sie fällig ist.

ACME lässt sich nicht ausschalten, solange HTTPS keine Zertifikatsdateien hat: Kalzit würde HTTPS
nicht wieder starten. Setze zuerst `tls.cert_file` und `tls.key_file` oder entferne
`server.https_addr`.

Jedes Speichern der Einstellungen (`tls.acme_changed`), jedes ausgestellte Zertifikat
(`tls.certificate_issued`) und jeder fehlgeschlagene Versuch (`tls.certificate_failed`, mit dem
Grund) steht im Audit-Log des Servers (**Verwaltung** > **Audit-Log des Servers**). Eine
Erneuerung, die du selbst startest, wird als `tls.certificate_requested` verzeichnet.

## Speicherung und der Secrets-Schlüssel

Der ACME-Kontoschlüssel und das Zertifikat mit seinem privaten Schlüssel werden im Ordner `acme`
des Datenordners gespeichert, verschlüsselt mit dem Secrets-Schlüssel wie die Passwörter der
Datenquellen ([Installation](installation.md#secrets-schlüssel)). `kalzit secrets rotate` verschlüsselt
sie mit der Datenbank neu. Ein Backup des Datenordners braucht daher den Secrets-Schlüssel, um das
Zertifikat wiederherzustellen; ohne ihn bestellt Kalzit einfach ein neues. Test- und
Produktivumgebung haben getrennte Konten.

## Wenn es nicht funktioniert

| Was du siehst | Was du prüfst |
|---|---|
| „lässt sich nicht auflösen“ | Den DNS-Eintrag des Namens; die Prüfung verwendet den Resolver dieses Servers |
| „konnte die Namen nicht prüfen“ mit *Connection refused* oder *Timeout* | Port 80 (HTTP-01) oder 443 (TLS-ALPN-01) ist aus dem Internet nicht erreichbar: Firewall, Weiterleitung im Router oder ein anderes Programm auf dem Port |
| „konnte die Namen nicht prüfen“ mit *unauthorized* | Der Name zeigt auf einen anderen Server, oder ein vorgeschalteter Proxy beantwortet `/.well-known/acme-challenge/` selbst |
| „Limit der Zertifizierungsstelle ist erreicht“ | Zu viele Zertifikate oder Fehlschläge; warte auf den nächsten Versuch und nutze beim Ausprobieren die Testumgebung |
| „In kalzit.toml sind Zertifikatsdateien gesetzt“ | Entferne `tls.cert_file` und `tls.key_file` und starte neu |
| Der Browser warnt vor einem selbstsignierten Zertifikat | Noch kein Zertifikat: Sieh dir den Zustand und den letzten Fehler auf der Karte an |

Mit mehreren Kalzit-Servern auf einer PostgreSQL-Datenbank hinter einem Load Balancer bestellt und
erneuert der leitende Server das Zertifikat, und jeder Server liefert es aus; HTTP-01-Prüfungen
beantwortet der Server, den die Zertifizierungsstelle gerade erreicht. Bevorzuge dort HTTP-01:
TLS-ALPN-01 braucht einen Balancer, der Port 443 als reines TCP durchreicht. Siehe
docs/operations/high-availability.md.
