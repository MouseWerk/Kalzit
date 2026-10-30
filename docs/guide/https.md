# HTTPS and certificates

Kalzit serves HTTPS itself (TLS 1.2 and 1.3, HTTP/2) when `server.https_addr` is set in
`kalzit.toml` or `KALZIT_SERVER_HTTPS_ADDR`. The certificate comes from one of two places:

- **your own files**: `tls.cert_file` and `tls.key_file` (PEM). Kalzit reloads them when they
  change, without a restart (`tls.reload_interval_secs`);
- **ACME**: without certificate files, Kalzit orders the certificate itself from Let's Encrypt or
  any other certificate authority that offers ACME, and renews it. Until the first one is issued,
  HTTPS serves a temporary self-signed certificate, which browsers warn about.

HTTPS without certificate files starts only when ACME is on: otherwise Kalzit refuses to start
and says which files are missing, so a mistyped configuration never ends up serving a self-signed
certificate for good. To switch an existing server to ACME, turn ACME on with HTTP-01 while HTTPS
is still off (Kalzit orders and stores the certificate over HTTP), then set `server.https_addr`
and restart: HTTPS starts with the stored certificate.

Behind a reverse proxy that terminates TLS (nginx, Caddy, Traefik, IIS), Kalzit needs neither: the
proxy holds the certificate.

## Before you turn ACME on

1. **Names in DNS.** Every name the certificate is for must resolve to this server from the
   internet (for an internal CA: from the CA).
2. **Listeners.** In `kalzit.toml`:

   ```toml
   [server]
   http_addr = "0.0.0.0:80"
   https_addr = "0.0.0.0:443"
   public_url = "https://kalzit.example.com"
   ```

   Ports below 1024 need the right to bind them; the deb and rpm service has it
   ([Installation](installation.md#debian-ubuntu-fedora-rhel-deb-and-rpm)). Behind a router or a
   container port mapping, forward 80 and 443 from outside to the ports Kalzit listens on.
3. **No certificate files.** `tls.cert_file` and `tls.key_file` must not be set; files always win.

## Set it up

As a server administrator, open **Settings** (Einstellungen) > **Network, HTTPS and proxy**
(Netzwerk, HTTPS und Proxy). Below the addresses are two cards: the certificate in use, and
**Automatic certificates (ACME)** (Automatische Zertifikate). The fields depend on each other, so
they apply only with **Save** (Speichern), never one by one:

| Field | What it does |
|---|---|
| Order certificates automatically | Turns ACME on or off. Off, the last certificate stays in use until it expires |
| Certificate authority | **Let's Encrypt**; **Let's Encrypt staging** (Test) for trying the setup, with generous limits but certificates no browser trusts; or **Other** |
| ACME address | Only for Other: the `https://` address of the CA's ACME directory, for example `https://ca.internal.example/acme/acme/directory` for step-ca |
| CA certificate | Only for Other, optional: the PEM certificate of an internal CA, trusted for that address in addition to the system's certificates |
| Names | One per line, up to 100. Wildcards (`*.example.com`) need DNS validation, which Kalzit does not offer |
| Contact email | Optional; the CA writes here before a certificate expires or when something is wrong |
| Validation | **HTTP-01**: the CA fetches a token from `http://<name>/.well-known/acme-challenge/` on port 80, answered by Kalzit's HTTP listener even when it redirects everything else to HTTPS. **TLS-ALPN-01**: the CA connects to port 443 and Kalzit's HTTPS listener answers; no port 80 needed |
| Accept the terms of service | Required: the CA issues certificates only when its terms are accepted |

**Test connection** (Verbindung testen) checks without saving: the ACME address answers as an
ACME directory, every name resolves, and it links the CA's terms. It warns when the listener of
the chosen validation is not on the port the CA connects to (80 or 443), which is fine when a
router forwards that port. **Save** runs the same checks; the first problem is shown at its
field. Start with **Let's Encrypt staging** until a certificate is issued, then switch to Let's
Encrypt: the staging limits are much higher, and a failed attempt does not count against the
production limits.

## Ordering and renewal

After a save, Kalzit orders a certificate in the background when none matches the settings
(other names, another CA). The card **HTTPS certificate** shows its state, the names, the
issuer, until when it is valid and when it will be renewed. The new certificate is served from
the next connection on, without a restart.

Kalzit renews once two thirds of the lifetime have passed: 30 days before the end of a 90-day
certificate. A failed attempt is retried after 5 minutes, then 15 minutes, 1, 3 and 6 hours, then
every 12 hours, so the CA's rate limits are respected; the card shows the reason and the next
attempt. **Renew now** (Jetzt erneuern) orders at once, for example after the certificate was
revoked. It is refused during the pause after a failed attempt (change the settings to try again
sooner) and while the certificate in use is younger than a third of its lifetime and matches the
settings, because every certificate counts against the CA's limits. A certificate that was issued
but could not be stored stays in use, the card shows why, and storing is tried again after a pause;
renewal goes on when it is due.

ACME cannot be turned off while HTTPS has no certificate files: Kalzit would not start HTTPS
again. Set `tls.cert_file` and `tls.key_file`, or remove `server.https_addr`, first.

Every save of the settings (`tls.acme_changed`), every certificate issued
(`tls.certificate_issued`) and every failed attempt (`tls.certificate_failed`, with the reason)
is in the server's audit log (**Administration** > **Server audit log**). A renewal you start
yourself is recorded as `tls.certificate_requested`.

## Storage and the secrets key

The ACME account key and the certificate with its private key are stored in the data directory's
`acme` folder, encrypted with the secrets key like data source passwords
([Installation](installation.md#secrets-key)). `kalzit secrets rotate` re-encrypts them with the
database. A backup of the data directory therefore needs the secrets key to restore the
certificate; without it, Kalzit simply orders a new one. Staging and production keep separate
accounts.

## When it does not work

| What you see | What to check |
|---|---|
| "does not resolve" | The name's DNS record; the check uses this server's resolver |
| "could not validate the names" with *Connection refused* or *Timeout* | Port 80 (HTTP-01) or 443 (TLS-ALPN-01) is not reachable from the internet: firewall, router forwarding, or another program on the port |
| "could not validate the names" with *unauthorized* | The name points to another server, or a proxy in front answers `/.well-known/acme-challenge/` itself |
| "rate limit was reached" | Too many certificates or failures; wait for the next attempt, and use staging while trying |
| "Certificate files are set in kalzit.toml" | Remove `tls.cert_file` and `tls.key_file` and restart |
| The browser warns about a self-signed certificate | No certificate yet: see the card's state and last error |

With several Kalzit servers on one PostgreSQL database behind a load balancer, the leading server
orders and renews the certificate and every server serves it; HTTP-01 validations are answered
by whichever server the certificate authority reaches. Prefer HTTP-01 there: TLS-ALPN-01 needs
the balancer to pass port 443 through as plain TCP. See docs/operations/high-availability.md.
