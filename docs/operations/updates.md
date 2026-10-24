# Updates: operator guide

How Kalzit finds, verifies, installs and returns from new versions, and what the project owner
does once to sign releases. The design is in docs/ARCHITECTURE.md, "Updates"; the API in
docs/api/updates.md.

## What Kalzit trusts

Every release on GitHub (MouseWerk/Kalzit) carries `kalzit-<version>-manifest.json`, its detached
signature `kalzit-<version>-manifest.json.sig`, one binary per platform and one offline package
(`.kalzit-update`) per binary. The manifest lists each binary with its size and SHA-256, and each
entry is signed on its own as well. Kalzit verifies the signatures with Ed25519 against the public
keys compiled into it; a signature by any other key, a changed file, a package for another
platform or an older version is refused, and nothing is installed. No setting can add a trusted
key at run time.

Kalzit asks GitHub only when you check, or once a day when "Check automatically" is on (off by
default). The request goes to `api.github.com`; files come from `github.com` and GitHub's file
hosts (`objects.githubusercontent.com`, `release-assets.githubusercontent.com`), over HTTPS. No
other host is contacted, also not through a redirect, and nothing about the server is sent.

## Installing online

1. Administration, Updates: "Check now" (or wait for the daily check).
2. "Download": the package lands in `<data dir>/updates/staging` and is verified there.
3. "Install now", or "Plan for ... 02:00" for the maintenance window (Administration, Updates,
   "Change"; local time of the administrator who plans it).

Installing makes a backup of the SQLite database (`<data dir>/updates/backups`), keeps the running
binary (`<data dir>/updates/versions/<version>/`), puts the new binary in place and restarts. The
first start of the new version is a trial: it must answer `/readyz` and accept connections within
`updates.health_timeout_secs` (60 s by default). If it does not, crashes, or its database migration
fails, Kalzit puts the previous binary and the backup back on its own and starts the previous
version; the history and the audit log say why. Changes made in the few seconds of a failed trial
are lost with it.

### Where Kalzit installs on its own

Automatic installation needs a restart Kalzit can do safely by itself:

- **Linux under systemd**, when the service account may replace the binary. Kalzit stops
  gracefully and replaces its process with the new binary, so the process id stays and systemd
  keeps supervising it. Install the binary where the service account can write it, for example:

  ```ini
  [Service]
  User=kalzit
  ExecStart=/opt/kalzit/kalzit serve
  Restart=on-failure
  StateDirectory=kalzit
  StateDirectoryMode=0700
  ConfigurationDirectory=kalzit
  ```

  with `sudo install -d -o kalzit -m 0755 /opt/kalzit` and the binary owned by `kalzit`.
  `Restart=on-failure` makes systemd start Kalzit again if a new version crashes during its
  trial; that start returns to the previous version. A binary owned by root (`/usr/local/bin`)
  stays manual, which some administrators prefer.
- **Windows**: not yet. Kalzit has no Windows service integration so far (it comes with the
  service installer, docs/PLAN.md, M5), so Windows downloads and verifies, and you install from the
  command line (next section).
- **Containers**: never; update the image.

The Updates page says why a server does not install on its own (`mode`).

## Installing from the command line

With the release downloaded or uploaded (it shows as "ready to install"):

```
# Linux: systemctl stop kalzit        Windows: stop Kalzit (or its service wrapper)
kalzit update status
kalzit update apply                    # PostgreSQL: add --acknowledge-no-backup after pg_dump
# Linux: systemctl start kalzit       Windows: start Kalzit again
```

Run it as the account Kalzit runs as, or as root/Administrator (files it creates in the data
directory are given to the data directory's owner on Linux). Use the same `--config` or
`KALZIT_CONFIG` as the service. `kalzit update apply` refuses while a server runs on the data
directory. The next start is the same trial with the same automatic return.

## Offline installations

For servers without internet access:

1. On a machine with access, download `kalzit-<version>-<platform>-<arch>.kalzit-update` from the
   GitHub release (`windows-x64` or `linux-x64`).
2. Carry it over and drop it on Administration, Updates, "Offline update". Kalzit verifies it
   exactly like a download.
3. Install as above.

The three loose files (manifest, signature, binary) can be uploaded instead through the API
(docs/api/updates.md).

## Returning to an earlier version

Kalzit keeps the last `updates.keep_versions` (3) previous binaries with the database backup taken
when each was left. In the history, "Return to this version" puts one back:

- if the database schema did not change since, only the binary changes and your data stays;
- otherwise the backup of that time replaces the database, and everything changed since is lost.
  Kalzit asks first.

From the command line: `kalzit update rollback <version>` (add `--restore-database` when asked),
with Kalzit stopped. On PostgreSQL, a return across a schema change needs your own `pg_restore`
of a dump from that time.

## PostgreSQL

Kalzit cannot back up a PostgreSQL database. Run `pg_dump` before you install and confirm it on
the page (or pass `--acknowledge-no-backup`). If a new version fails its trial after its migration
ran, Kalzit returns to the previous binary, which then may not start on the newer schema: restore
the dump, then start Kalzit.

## Backups

Backups are SQLite files (`VACUUM INTO`, consistent while the server runs). They contain password
hashes, sessions and the encrypted data source secrets, but not the key that decrypts them
(docs/ARCHITECTURE.md, "Backups"). "Back up now" adds a manual backup; the newest
`updates.keep_versions` manual backups are kept. Downloads are recorded in the audit log.

## Release key (project owner, once)

The signing key never leaves the owner's machine and the repository secret store; nobody commits
it, and the build does not generate one.

1. Make the key pair locally (a checkout of the repository with Rust installed):

   ```
   cargo run --release -p kalzit --bin kalzit-sign -- keygen --out kalzit-release.key
   ```

   It writes the private key (base64, 32 bytes) into `kalzit-release.key`, readable only by you,
   and prints the public key and its key id.
2. Store the private key as the repository secret `KALZIT_RELEASE_SIGNING_KEY`:
   GitHub, MouseWerk/Kalzit, Settings, Secrets and variables, Actions, New repository secret,
   name `KALZIT_RELEASE_SIGNING_KEY`, value: the content of `kalzit-release.key`
   (or `gh secret set KALZIT_RELEASE_SIGNING_KEY < kalzit-release.key`).
3. Put the public key into `server/src/updates/signing.rs`, in a pull request: add
   `const RELEASE_KEY_2026: &str = "<printed public key>";` and list it in `COMPILED_KEYS` in place
   of `RELEASE_KEY_PLACEHOLDER` (`&[RELEASE_KEY_2026]`). Until then, builds trust no key and
   refuse every update; the Updates page says so. The key id on the Updates page (`trustedKeys`)
   lets administrators compare it with the one you publish.
4. Keep an offline copy of `kalzit-release.key` (a password manager or an encrypted USB stick),
   then delete the file from the working machine.

Optionally, the repository variable `KALZIT_UPDATE_PUBLIC_KEYS` (comma-separated public keys) is
compiled in as well by the release workflow, for a key that should be trusted without a code
change; the compiled list is the normal place.

## Publishing a release

1. Set `version` in `server/Cargo.toml`, write `docs/releases/v<version>.md` (its "## New",
   "## Improved", "## Fixed" and "## Security" lines become the highlights on the Updates page),
   merge.
2. Tag: `git tag v<version> && git push origin v<version>`. A tag with a pre-release part
   (`v0.3.0-rc.1`) becomes a GitHub pre-release, offered only on the preview channel.
3. `.github/workflows/release.yml` builds Windows and Linux x64 binaries with the UI, checks that
   each runs and names its version, signs the manifest with `KALZIT_RELEASE_SIGNING_KEY`, verifies
   its own output, and publishes the binaries, manifest, signature and offline packages as the
   GitHub release.

## Key rotation

1. Make a new key pair (`keygen`, step 1 above).
2. Add the new public key to `COMPILED_KEYS` in front of the old one, release a version signed
   with the **old** key. Servers that install it trust both keys.
3. Replace the repository secret with the new private key; from now on releases are signed with
   it. Servers on the release from step 2 accept them.
4. After most servers updated, remove the old key from `COMPILED_KEYS` in a later release.
   Servers older than step 2 install that release offline only after updating to the step 2
   release first (set `minimumVersion` in the manifest if needed).

If a private key leaks, remove its public key in a release signed with the other key at once, and
tell administrators to verify the key id shown on the Updates page.
