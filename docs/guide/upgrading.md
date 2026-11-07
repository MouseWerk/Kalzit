# Upgrading

How to move a Kalzit server to a new release, by the way it was installed. The details of the
built-in updater (signatures, the trial start, returning to an earlier version, offline packages)
are in the [updates guide](../operations/updates.md); several servers on one database are updated
one after the other ([operator guide](../operations/high-availability.md#rolling-updates)).

## Before every upgrade

1. **Read the release notes** of every version between yours and the new one
   ([docs/releases](../releases)). A release whose notes say "stop every server" must not run next
   to an older version on the same database.
2. **Back up** the database, the secrets key and the data folder
   ([Backup and restore](backup.md)). The built-in updater backs up a SQLite database by itself;
   the packages, the MSI and a new container image do not, and Kalzit never backs up PostgreSQL.
3. **Pick a quiet time.** Kalzit restarts, which interrupts everyone briefly; Administration >
   Updates shows how many people were active in the last 30 minutes.

The new version migrates the database on its first start. A release can name a minimum version
to upgrade from; the updater refuses such a release on an older server. An
older version cannot open a database a newer one migrated: going back needs the backup taken
before, or the updater's own return (below).

## By installation

| Installed with | Upgrade with |
|---|---|
| deb or rpm package | The new package for the same processor: `sudo apt install ./kalzit-<version>-linux-x64.deb` or `sudo dnf install ./kalzit-<version>-linux-x64.rpm` (`arm64` on ARM). The package restarts the service. Administration > Updates shows the command but never installs itself ([Installation](installation.md#updates)) |
| MSI on Windows | The new MSI over the installed one; settings and data stay and the service starts again. With `SELFUPDATE=1`, Administration > Updates can install on its own ([Installation](installation.md#updates-2)) |
| Container image | Pull the new tag and recreate the container (`docker compose pull && docker compose up -d`); the updater never replaces a container's program ([Installation](installation.md#updates-1)) |
| Plain binary on Linux | Stop, replace the binary, start; or let Administration > Updates install it when the service account owns the binary ([Linux without a package](linux-binary.md#updates)) |
| Built from source | Build the new tag and replace the binary with the service stopped |

## With the built-in updater

Where Kalzit may replace its own program (a plain binary the service account owns, or the Windows
service with `SELFUPDATE=1`), **Administration** (Verwaltung) > **Updates**:

1. **Check now**, then **Download**: the release is verified against Kalzit's release key before
   anything else happens.
2. **Install now**, or plan it for the maintenance window.
3. Kalzit backs up a SQLite database, keeps the running version, starts the new one and waits for it
   to report healthy (60 seconds by default). If it does not, Kalzit returns to the previous version
   and the backup on its own; the history says why.

The history offers **Return to this version** for the kept versions
([returning to an earlier version](../operations/updates.md#returning-to-an-earlier-version)).
Servers without internet access take the same signed release as an offline package
([offline installations](../operations/updates.md#offline-installations)).

## After the upgrade

- Administration > Updates (and Administration > Instances with several servers) shows the new
  version.
- Open a dashboard and run a query in Explore; check that plugins still run (Settings > Plugins).
- Work through the release notes' "Checklist for Windows (manual)" where it applies to you.
