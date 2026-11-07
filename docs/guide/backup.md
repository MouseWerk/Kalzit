# Backup and restore

What to back up, how to take a consistent copy while Kalzit runs, and how to restore it, for
SQLite and PostgreSQL as Kalzit's own database, on Linux, Windows and in a container. Practise the
restore once (the [drill](#restore-drill) at the end) before you rely on it.

Kalzit has no backup schedule of its own (planned for M7): run the steps below from your usual
backup tool or a timer. The built-in updater backs up the SQLite database before every update it
installs itself (not before a package, MSI or image upgrade), and **Administration** (Verwaltung) >
**Updates** has **Back up now**; those copies stay on the same
disk and are meant for returning from an update, not as your only backup
([updates guide](../operations/updates.md#backups)).

## What to back up

| What | Where | Why |
|---|---|---|
| The database | SQLite: `kalzit.db` in the data folder (with `kalzit.db-wal` and `kalzit.db-shm` while it runs). PostgreSQL: the database in `database.url` | Everything you made in Kalzit: organizations, people, dashboards, data sources, settings, the audit log; data source passwords and tokens encrypted |
| The secrets key | `KALZIT_SECRETS_KEY`, the systemd credential `kalzit-secrets-key` (the deb and rpm put it in `/etc/credstore.encrypted/` or `/etc/credstore/`), the Docker secret `kalzit-secrets-key`, or a key file in the data folder (`secrets.key` on Linux, `secrets.key.dpapi` on Windows) | Without it the stored passwords, tokens, AI provider keys, the mail server's password and the ACME files cannot be decrypted |
| `acme/` in the data folder | `account-<hash>.enc` and `certificate.enc` | The ACME account and the certificate Kalzit ordered, encrypted with the secrets key. With several servers on PostgreSQL the certificate is also in the database |
| `plugins/` in the data folder | The installed plugin packages, unpacked | The database lists the plugins; on SQLite the packages exist only here. With several servers on PostgreSQL they are also in the database |
| `kalzit.toml` | `/etc/kalzit/kalzit.toml` (packages), `%ProgramData%\Kalzit\kalzit.toml` (Windows), or the file you start Kalzit with | Addresses, HTTPS, proxies, the database URL |
| Certificate files | `tls.cert_file` and `tls.key_file`, if you use your own | HTTPS |

The rest of the data folder can be backed up as well, but is not needed for a restore:
`updates/` (downloads, kept versions and the update backups), `logs/` (Windows), `tls/` (the
Windows installer's self-signed certificate, made again when missing) and `samples/` (the sample
database, written again when someone adds the sample data). Do not restore `kalzit-node-id` onto
another machine that runs at the same time as the original (see [several servers](#several-servers)).

**The secrets key belongs to the backup.** Keep a copy of it apart from the database backup, for
example in your password manager, and keep old keys as long as you keep backups taken with them
(`kalzit secrets rotate` changes the key; see the [README](../../README.md#configuration)).

- On Linux with the packages, the key in `/etc/credstore.encrypted/` is encrypted with the host's
  credential key, `/var/lib/systemd/credential.secret`: back that file up too, or a restore on
  other hardware cannot read the key.
- On Windows, `secrets.key.dpapi` can only be decrypted on the same computer. Copied to another
  computer, it makes Kalzit refuse to start. When you restore on other hardware, leave that file
  out: Kalzit then makes a new key, every stored password, token and key has to be entered again,
  and ACME orders a new certificate. To restore on other hardware without that, run Kalzit with
  `KALZIT_SECRETS_KEY` from the start and keep that key.

## SQLite

### While Kalzit runs

Never copy only `kalzit.db` of a running server: what is still in `kalzit.db-wal` would be lost.
Take a consistent copy with the SQLite shell instead, as the account Kalzit runs as or as root:

```sh
# Linux (packages): one consistent file, safe while Kalzit runs
sudo -u kalzit sqlite3 /var/lib/kalzit/kalzit.db "VACUUM INTO '/var/lib/kalzit/backup-$(date +%F).db'"
sudo tar -C /var/lib/kalzit -czf /srv/backup/kalzit-$(date +%F).tar.gz \
  backup-$(date +%F).db acme plugins
sudo rm /var/lib/kalzit/backup-$(date +%F).db
sudo cp /etc/kalzit/kalzit.toml /srv/backup/
```

`.backup <file>` in the `sqlite3` shell works as well. On Windows, run `sqlite3.exe` from an
elevated prompt the same way, with the database at `%ProgramData%\Kalzit\data\kalzit.db`, and copy
`acme` and `plugins` next to it. **Back up now** on the Updates page makes the same kind of copy
(`VACUUM INTO`) in `updates/backups` and offers it for download; the download is in the audit log.

### With Kalzit stopped

Stop the service (`sudo systemctl stop kalzit`, `Stop-Service Kalzit`, `docker stop --time 30
kalzit`), copy the whole data folder, start it again. After a clean stop `kalzit.db-wal` and
`kalzit.db-shm` are usually gone; if they are there, copy them together with `kalzit.db`.

For a container, copy the volume while the container is stopped:

```sh
docker stop --time 30 kalzit
docker run --rm -v kalzit-data:/data:ro -v "$PWD":/backup alpine \
  tar -C /data -czf /backup/kalzit-data.tar.gz .
docker start kalzit
```

Compose prefixes the names with the project (by default the folder's name): the volume is then
for example `kalzit_kalzit-data` and the container `kalzit-kalzit-1`; `docker volume ls` and
`docker compose ps` show them.

### Restore

1. Install the same Kalzit version the backup was taken with (a newer version migrates the
   database on its first start; an older one cannot open a database a newer one migrated).
2. Stop Kalzit.
3. Put the files into the data folder: the database as `kalzit.db` (remove a `kalzit.db-wal` and
   `kalzit.db-shm` left from before), `acme/` and `plugins/`.
   - **Copy, do not move.** A copied file takes the data folder's private permissions; a moved one
     keeps its old ones, and Kalzit refuses to start with it. On Windows, tools that copy
     permissions (`robocopy /COPYALL` or `/SEC`, `xcopy /O`) keep foreign entries as well: use a
     plain copy, or run `icacls <file> /reset` afterwards.
   - On Linux the files must belong to the account Kalzit runs as
     (`sudo chown -R kalzit:kalzit /var/lib/kalzit`), and the folder must stay closed to others
     (`chmod 700`).
   - In a container, restore into the stopped container's volume and give the files to the
     image's user:

     ```sh
     docker stop kalzit
     docker run --rm -v kalzit-data:/data -v "$PWD":/backup alpine        sh -c 'rm -rf /data/* && tar -C /data -xzf /backup/kalzit-data.tar.gz && chown -R 65532:65532 /data && chmod 700 /data'
     docker start kalzit
     ```
4. Put back `kalzit.toml` and the secrets key the backup was taken with (on Windows on another
   computer, without `secrets.key.dpapi`, see above).
5. Start Kalzit and check the log: a warning that stored secrets use keys which are not loaded
   means the key is not the one the backup was taken with.

## PostgreSQL

Kalzit cannot back up a PostgreSQL database itself. Use the tools of PostgreSQL, while Kalzit
runs:

```sh
pg_dump --format=custom --file=kalzit-$(date +%F).dump "postgres://kalzit@db.internal/kalzit"
```

Back up the data folder's `acme/` and `plugins/` and `kalzit.toml` of each server as well, and the
secrets key, which every server shares.

To restore, stop every Kalzit server, restore into an empty database and start one server, then
the others:

```sh
createdb -O kalzit kalzit
pg_restore --no-owner --role=kalzit --dbname="postgres://kalzit@db.internal/kalzit" kalzit-2026-11-04.dump
```

The version rule is the same as for SQLite: start the version the dump was taken with, or a newer
one. Point-in-time recovery, replicas and failover (Patroni, a managed database) are PostgreSQL's
job; Kalzit reconnects after a failover.

## Several servers

With several Kalzit servers on one PostgreSQL database
([operator guide](../operations/high-availability.md)), the database and the secrets key are
shared; each server's data folder is its own. Back up the database once and `kalzit.toml` of
each server. To rebuild a server, start Kalzit with an empty data folder, the same database URL
and the same key: it registers itself and unpacks the plugins from the database. Do not copy a
data folder to set up another server; its `kalzit-node-id` would make two servers one.

## Restore drill

Try the restore on a second machine or a virtual machine once, and after every change to how you
back up:

1. Install the Kalzit version of the backup there, without starting it (with the packages, stop
   the service right after the installation).
2. Restore the database (or the dump), `acme/`, `plugins/`, `kalzit.toml` and the secrets key as
   above. Change `server.public_url` and the addresses in `kalzit.toml` if the test machine has
   another name, and keep it away from your production data sources if a test run should not
   query them.
3. Start Kalzit and check:
   - you can sign in, and dashboards, folders and saved analyses are there;
   - **Test connection** on a data source with a password succeeds (the key is right);
   - Settings > Plugins (Einstellungen > Plugins) lists the plugins as running;
   - the audit log ends at the time of the backup;
   - with ACME, the certificate card shows the certificate of the backup.
4. Note how long the restore took, then remove the test installation.
