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
- **Windows as the Kalzit service** (the MSI package or `kalzit service install`, see
  docs/guide/installation.md, "Windows"), with self-update on (the default): the service account
  may replace `kalzit.exe` in the program folder. Kalzit stops gracefully, puts the new binary in
  place and ends the service with a restart request; the service's recovery actions start it
  again two seconds later, now with the new version, for the same trial as on Linux. A failed
  trial returns the same way. Installed with `SELFUPDATE=0` (or `--self-update 0`), the program
  folder stays for Administrators only and you install from the command line (next section) or
  with the next MSI package. Kalzit started in a console on Windows also installs from the
  command line.
- **Containers**: never; update the image.

The Updates page says why a server does not install on its own (`mode`).

## Installing from the command line

With the release downloaded or uploaded (it shows as "ready to install"):

```
# Linux: systemctl stop kalzit        Windows: Stop-Service Kalzit (elevated PowerShell)
kalzit update status
kalzit update apply                    # PostgreSQL: add --acknowledge-no-backup after pg_dump
# Linux: systemctl start kalzit       Windows: Start-Service Kalzit
```

Use the same `--config` or `KALZIT_CONFIG` as the service. `kalzit update apply` refuses while a
server runs on the data directory. The next start is the same trial with the same automatic
return.

The command usually runs with more rights than the service (root, an Administrator), and nothing
it reads from the data directory, which the service account can write, is trusted for that:

- The staged package is opened once, copied into the binary's own folder (which the service
  account cannot write) and checked there against the release's signed SHA-256; only that copy
  runs for the smoke test (with an empty environment) and replaces the binary.
- On Linux, run as root on a data directory another account owns, the command does everything in
  the data directory (lock, database, backup, kept versions, plan) with that account's user and
  group ids, and switches back to root only to copy into the binary's folder, run the smoke test
  and rename. Files it creates in the data directory belong to the service account.
- Files from the data directory are opened only as regular files, never through a link.
- On Windows the folders below `updates/` are checked not to be links or junctions before they are
  used. The copy into the binary's folder and its hash check protect the binary itself. The service
  account could still swap such a folder for a junction between that check and its use, so keep
  the service account a virtual account (`NT SERVICE\Kalzit`, as the installer sets up) that
  nothing else uses; a service with self-update on installs as that account itself.

## Offline installations

For servers without internet access:

1. On a machine with access, download `kalzit-<version>-<platform>-<arch>.kalzit-update` from the
   GitHub release (`windows-x64` or `linux-x64`).
2. Carry it over and drop it on Administration, Updates, "Offline update". Kalzit verifies it
   exactly like a download. One upload runs at a time, and only when the data directory's disk has
   room for twice its size.
3. Install as above.

The three loose files (manifest, signature, binary) can be uploaded instead through the API
(docs/api/updates.md). A preview release is refused while the channel is Stable.

## Returning to an earlier version

Kalzit keeps the last `updates.keep_versions` (3) previous binaries with the database backup taken
when each was left, the SHA-256 of each kept binary, and the signed manifest of each release it
installed. In the history, "Return to this version" puts one back after its copy matched that
hash:

- if the database schema did not change since, only the binary changes and your data stays;
- otherwise the backup of that time replaces the database, and everything changed since is lost.
  Kalzit asks first.

From the command line: `kalzit update rollback <version>` (add `--restore-database` when asked),
with Kalzit stopped. The command line returns only to versions installed through an update
(listed in the history) whose signed manifest was kept; a version installed by hand is returned
to from the page.
On PostgreSQL, a return across a schema change needs your own `pg_restore` of a dump from that time.

### When a new version is not healthy

The first start of a new version must report healthy within `updates.health_timeout_secs` (15 to
1800 s). If it does not, crashes, or refuses the configuration (`kalzit.toml` or `KALZIT_*`
variables it does not accept), Kalzit restores the backup and the previous binary (checked against
its recorded SHA-256) and starts the previous version.

- Linux replaces the process with the previous binary at once.
- Windows: when the health check fails or the start fails, the server stops and starts the
  previous binary (the service: through a restart by the service manager). When the time runs out
  while the server hangs, it only ends; the return happens at the next start, which for the
  service its recovery actions make a few seconds later, and in a console you make.
- A `plan.json` that this version cannot read (damaged, or written by a newer format) is moved
  aside as `plan-<time>.unreadable.json` with an error in the log: check which binary is in place
  and restore a backup from `updates/backups` if needed.

## PostgreSQL

Kalzit cannot back up a PostgreSQL database. Run `pg_dump` before you install and confirm it on
the page (or pass `--acknowledge-no-backup`); a planned installation asks for the same confirmation
when you plan it, and one planned without it is not installed and shows in the history.

If the new version brings database migrations, Kalzit does not return on PostgreSQL once its
trial began: the migrations may have run, or partly run, and the previous binary could not start
on the newer schema. A failed new version keeps running, the log says so, and the plan is moved
aside as `plan-<time>.kept-new.json`. To go back, restore your dump and install the previous
version by hand. A new version without new migrations returns as on SQLite.

## Backups

Backups are SQLite files (`VACUUM INTO`, consistent while the server runs), readable only by the
service account on Linux (mode 0600). They contain password hashes, sessions and the encrypted data
source secrets, but not the key that decrypts them (docs/ARCHITECTURE.md, "Backups"). "Back up
now" adds a manual backup; the newest `updates.keep_versions` manual backups are kept. Downloads
are recorded in the audit log.

## Release key (project owner, once)

The signing key never leaves the owner's machine and the release environment's secret store;
nobody commits it, and the build does not generate one.

1. Make the key pair locally (a checkout of the repository with Rust installed):

   ```
   cargo run --release -p kalzit-release --bin kalzit-sign -- keygen --out kalzit-release.key
   ```

   It takes 32 bytes from the operating system's random source, writes the private key (base64)
   into the new file `kalzit-release.key`, readable only by you (mode 0600 on Linux and macOS, an
   ACL for your account alone on Windows), and prints the public key and its key id.
2. Make a **second** key pair the same way (`kalzit-release-backup.key`) and keep it offline only
   (an encrypted USB stick in a safe). It never goes into GitHub. Listing its public key as well
   lets you revoke the first key with a release signed by the second if the first one leaks.
3. Create the environment `release` (GitHub, MouseWerk/Kalzit, Settings, Environments, New
   environment, name `release`): add yourself (and anyone else who may approve releases) as
   required reviewers, enable "Prevent self-review" if more than one person releases, and limit
   "Deployment branches and tags" to tags matching `v*`.
4. Store the first private key as the environment secret: in the `release` environment, Add
   environment secret, name `KALZIT_RELEASE_SIGNING_KEY`, value: the content of
   `kalzit-release.key` (or `gh secret set KALZIT_RELEASE_SIGNING_KEY --env release <
   kalzit-release.key`). Do not keep it as a repository secret.
5. Protect release tags: Settings, Rules, Rulesets, New tag ruleset, target tags `v*`, enforcement
   active, rules "Restrict creations", "Restrict updates" and "Restrict deletions", with only the
   repository admins (or a release team) in the bypass list. Then only they can push a `v*` tag,
   and a published tag cannot be moved.
6. Put both public keys into `server/src/updates/signing.rs`, in a pull request: add
   `const RELEASE_KEY_2026: &str = "<first public key>";` and
   `const RELEASE_KEY_2026_OFFLINE: &str = "<second public key>";` and set
   `COMPILED_KEYS = &[RELEASE_KEY_2026, RELEASE_KEY_2026_OFFLINE]` in place of
   `RELEASE_KEY_PLACEHOLDER`. Until then, builds trust no key and refuse every update; the Updates
   page says so. The key ids on the Updates page (`trustedKeys`) let administrators compare them
   with the ones you publish.
7. Keep offline copies of both files, then delete them from the working machine.

Optionally, the repository variable `KALZIT_UPDATE_PUBLIC_KEYS` (comma-separated public keys) is
compiled in as well by the release workflow, for a key that should be trusted without a code
change; the compiled list is the normal place.

## Publishing a release

1. Set `version` in `server/Cargo.toml`, write `docs/releases/v<version>.md` (its "## New",
   "## Improved", "## Fixed" and "## Security" lines become the highlights on the Updates page),
   merge.
2. Tag the merged commit of `main`: `git tag v<version> && git push origin v<version>`. A tag with
   a pre-release part (`v0.3.0-rc.1`) becomes a GitHub pre-release, offered only on the preview
   channel.
3. `.github/workflows/release.yml` refuses a tag that is not on `main`, builds Windows and Linux
   x64 binaries with the UI, checks that each runs and names its version, then waits for a
   reviewer of the `release` environment. After the approval it builds only the small
   `kalzit-release` crate, signs the manifest with `KALZIT_RELEASE_SIGNING_KEY`, verifies its own
   output, and publishes the binaries, manifest, signature and offline packages as the GitHub
   release. Every action in it is pinned to a commit; update the pins on purpose, after reading
   the change.

## Key rotation

1. Make a new key pair (`keygen`, step 1 above).
2. Add the new public key to `COMPILED_KEYS` in front of the old one, release a version signed
   with the **old** key. Servers that install it trust both keys.
3. Replace the environment secret with the new private key; from now on releases are signed with
   it. Servers on the release from step 2 accept them.
4. After most servers updated, remove the old key from `COMPILED_KEYS` in a later release.
   Servers older than step 2 install that release offline only after updating to the step 2
   release first (set `minimumVersion` in the manifest if needed).

If the online key leaks: sign a release with the offline key that removes the leaked public key
from `COMPILED_KEYS` (and adds a new pair), publish it at once, and tell administrators to check
the key ids on the Updates page. Servers trust the offline key already, so they install it.
