English | [Deutsch](de/offline.md)

# Offline and air-gapped operation

Kalzit works fully on a network without internet access. Nothing outside your network is required:
every outside system is optional or set up by an administrator, and when one is missing, Kalzit
still starts and every page still opens. The affected feature shows an error of its own, nothing
more.

## What works offline

- **Start-up and the whole interface.** The page, its fonts, icons and licence texts are inside
  the Kalzit binary. The page loads nothing from another site, and the server's content security
  policy only lets it use its own address (plus `data:` and `blob:` for images and workers). Tests
  in the repository keep this true.
- **Sign-in with local accounts**, organizations, teams, roles, the audit log and settings.
- **Dashboards, Explore, saved analyses, export and the bundled help**, on data sources in your
  network, including those on the same machine.
- **Kalzit's own database**, SQLite or a PostgreSQL server of yours. A PostgreSQL host given by
  name is looked up in the background after start; an unreachable name server never delays the
  start, and until the name is known Kalzit refuses its own database's port as a data source
  target.
- **Alert rules and their states**, silences and the policy tree.
- **Plugins from a file**, and updates by an offline package (below).

## What reaches outside, and when

Each of these is off, or only used after an administrator configured it:

| Feature | What it contacts | Default |
|---|---|---|
| Data sources | The database or service you entered, wherever it runs | Only the sources you create |
| AI | The provider you connect (OpenAI-compatible, Anthropic, or a local model such as Ollama on your network) | Off; a local provider needs no internet |
| Mail (invitations, password links, reports) | The SMTP server you enter | Off until configured |
| Alert contact points: webhooks, Slack, Microsoft Teams | The addresses you enter in the contact point | None until you add one |
| Sign-in providers: OpenID Connect, SAML, LDAP | The identity provider or directory you enter | Off; local accounts work |
| Automatic certificates (ACME, Let's Encrypt) | The certificate authority you enter | Off; use your own certificate files |
| Plugin catalog | The catalog address you enter | Off, no address by default; installing from a file always works |
| Update check and download | `api.github.com` and GitHub's file hosts | Check only on request; "Check automatically" is off |
| Map images | No panel loads map images from the internet. A future map panel takes its tiles from a source you configure | Not applicable |

A proxy for these outgoing requests is set under Administration, Settings, Network, HTTPS and
proxy ([Administration](administration.md#outbound-proxy)). Hosts in your own network can be listed
there so they are reached directly.

Two things are not part of the product itself. The help and documentation links in the interface
currently point to GitHub and open only with internet access; the built-in handbook replaces these
links. The About page links the repository, the website and the security policy as external
links; the licence text opens from Kalzit itself.

## Updating offline

1. On a machine with internet, download `kalzit-<version>-<platform>-<arch>.kalzit-update` from the
   [GitHub release](https://github.com/MouseWerk/Kalzit/releases) (`windows-x64`, `linux-x64` or
   `linux-arm64`).
2. Carry it to your network and sign in as a server administrator.
3. Open Administration, Updates, **Offline update**, drop the package there or choose the file.
4. Kalzit checks the signature against the public keys built into it, that the package is for this
   platform and that its version is newer. Then it shows that the package is verified.
5. Install it now or in a maintenance window. A backup is made first.

The upload needs room for twice the package's size in the data folder. The three loose files
(manifest, signature, binary) can be uploaded through the API instead; see the
[update guide](../operations/updates.md#offline-installations) and
[docs/api/updates.md](../api/updates.md). Installing a plugin from a file needs no internet either.
