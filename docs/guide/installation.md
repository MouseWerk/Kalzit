# Installation

Kalzit is one program, `kalzit`, with the web interface built in. On Linux, install the deb or
rpm package, which runs it as a systemd service; or run it as a container image; or build the
binary from source and run it directly or as a service (see the
[README](../../README.md#quick-start) and "Running as a service" in
[ARCHITECTURE](../ARCHITECTURE.md#running-as-a-service)). After the installation, continue with
[Getting started](getting-started.md). HTTPS, with your own certificate or one from Let's Encrypt,
is described in [HTTPS and certificates](https.md).

## Debian, Ubuntu, Fedora, RHEL (deb and rpm)

Every release has `kalzit-<version>-linux-x64.deb` and `kalzit-<version>-linux-x64.rpm` for x86-64.
They need the glibc the release binary was built against (the package says which and refuses an
older system): Debian 13, Ubuntu 24.04, Fedora 41, RHEL, Rocky and AlmaLinux 10 or newer. Both
are listed with their size, SHA-256 and signature in the release's signed manifest
(`kalzit-<version>-manifest.json`), next to the binaries.

### Install

Download the package from the [releases](https://github.com/MouseWerk/Kalzit/releases), then:

```sh
# Debian, Ubuntu
sudo apt install ./kalzit-0.5.0-linux-x64.deb
# Fedora, RHEL, Rocky, Alma
sudo dnf install ./kalzit-0.5.0-linux-x64.rpm
sudo systemctl enable --now kalzit
```

The deb starts the service at once; the rpm follows the system's preset, which on Fedora and RHEL
leaves new services off, so it is started with `systemctl enable --now kalzit`. Open
`http://<server>:3000` and enter the setup code, which `sudo kalzit setup-code` prints
([Getting started](getting-started.md)).

To check a download against the signed manifest, compare its SHA-256 with the `installers` entry
of the manifest (`sha256sum kalzit-0.5.0-linux-x64.deb`); `kalzit-sign verify --public-key <key>
--manifest kalzit-0.5.0-manifest.json --signature kalzit-0.5.0-manifest.json.sig --installer
kalzit-0.5.0-linux-x64.deb` checks the manifest's signature too
([updates](../operations/updates.md)).

### What the package installs

| Path | What it is |
|---|---|
| `/usr/bin/kalzit` | The program |
| `/usr/lib/systemd/system/kalzit.service` | The service; change it with `sudo systemctl edit kalzit` |
| `/etc/kalzit/kalzit.toml` | The configuration: root may write it, the service only read it (`root:kalzit`, `0640`). Your changes stay on updates |
| `/var/lib/kalzit` | The data directory (database, ACME certificates, plugins), owned by `kalzit`, mode `0700` |
| `/etc/credstore.encrypted/kalzit-secrets-key` | The secrets key, encrypted with `systemd-creds` (where that is not possible: `/etc/credstore/kalzit-secrets-key`, readable by root only) |

The service runs as the system account `kalzit` (no login, no shell), which the package creates.
The unit is hardened: the file system is read-only except the data directory
(`ProtectSystem=strict`, `ReadWritePaths=/var/lib/kalzit`), no new privileges, no access to
home directories, devices, kernel settings or other processes, and a system call filter. It
keeps what the plugin sandbox needs (user, IPC and network namespaces, Landlock, seccomp);
`sudo -u kalzit kalzit sandbox-check` lists the protections plugins get on this system, and the
packages' tests check that the unit takes none of them away. The service may bind ports below 1024
(`CAP_NET_BIND_SERVICE`), so HTTPS on 443 and HTTP on 80 work without root.

### Configuration and secrets key

Edit `/etc/kalzit/kalzit.toml` and restart: `sudo systemctl restart kalzit`. The settings are
described in the [README](../../README.md#configuration). Logs are in the journal:
`journalctl -u kalzit`.

The first installation creates the secrets key in the system credential store and the service
imports it (`ImportCredential=`), so the key is neither in the data directory nor in an
environment variable. It is encrypted with the host's credential key
(`/var/lib/systemd/credential.secret`), not with a TPM, so a restored backup on other hardware
still works when that file is restored with it. Back up both the key and that file with your
data: without the key, the stored data source passwords cannot be decrypted. A data directory
that already holds a database or a key file keeps its key; the package never replaces one.

To use your own key, write it before the first start:
`openssl rand -base64 32 | sudo systemd-creds encrypt --name=kalzit-secrets-key -
/etc/credstore.encrypted/kalzit-secrets-key`. `kalzit secrets rotate` changes it later (the
service stopped, the new key in `KALZIT_SECRETS_NEW_KEY`, then the credential file replaced).

### Updates

Installed from a package, the package manager owns `/usr/bin/kalzit`: **Administration**
(Verwaltung) > **Updates** shows a new release with its notes and the command that installs it,
and neither the web interface nor `kalzit update apply` replaces the program. Download the new
package and install it like the first one:

```sh
sudo apt install ./kalzit-0.5.1-linux-x64.deb   # or: sudo dnf install ./kalzit-0.5.1-linux-x64.rpm
```

The package restarts a running service; the new version migrates the database on its first
start. Back up `/var/lib/kalzit` first (the package does not); see the
[updates guide](../operations/updates.md) for backups and PostgreSQL.

### Remove

`sudo apt remove kalzit` or `sudo dnf remove kalzit` stops and disables the service and removes
the program. The data directory, the configuration and the secrets key stay, so a later
installation finds everything again. `sudo apt purge kalzit` also deletes `/var/lib/kalzit`,
`/etc/kalzit` and the secrets key; rpm has no purge, so there they are deleted by hand:

```sh
sudo rm -rf /var/lib/kalzit /etc/kalzit
sudo rm -f /etc/credstore.encrypted/kalzit-secrets-key /etc/credstore/kalzit-secrets-key
```

The `kalzit` account stays in both cases (`sudo userdel kalzit` removes it).

## Docker

The image `ghcr.io/mousewerk/kalzit` is built for Linux on amd64 and arm64. On Windows and macOS it
runs in Docker Desktop (on Windows with the WSL2 back end, which runs the Linux image).

| Tag | What it is |
|---|---|
| `0.2.0` | Exactly this release |
| `0.2` | The newest release of 0.2 |
| `latest` | The newest stable release (pre-releases such as `0.3.0-rc.1` only have their own tag) |

Pin a version (`0.2.0` or `0.2`) for servers you depend on, so an update happens when you decide.

### Run

```sh
docker run -d --name kalzit --restart unless-stopped \
  -p 3000:3000 \
  -v kalzit-data:/var/lib/kalzit \
  ghcr.io/mousewerk/kalzit:0.2
```

Kalzit listens on port 3000 in the container; publish it on any port of the host
(`-p 8080:3000`). Open `http://localhost:3000` (or the host port you chose).

### First start

On the first start Kalzit writes a one-time **Setup code** (Einrichtungscode) to the data
directory, and the log says where it is. The image has no shell, so print it with Kalzit itself:

```sh
docker exec kalzit kalzit setup-code
```

Enter the code on the setup page; it is checked on its own step, before you create the owner
account and name the organization, as described in
[Getting started](getting-started.md#first-setup). Once the owner exists, the code is gone. Each
restart before that makes a new code, and the page tells an old code from a wrong one. To choose
the code yourself (for automated installs), set `KALZIT_SETUP_TOKEN` to at least 16 letters or
digits; the setup page then points to that variable.

Before anyone signs in, the setup page only names the default paths (`/var/lib/kalzit` in Linux
and the image, `C:\ProgramData\Kalzit\data` on Windows) and the Docker command, never the
paths this server really uses.

### Data and the volume

Everything Kalzit keeps lives in `/var/lib/kalzit`, a volume: the SQLite database, the setup
code, the fallback key file, the update state and the sample database (`samples/`, written when
someone adds the sample data). Keep it in a named volume (`kalzit-data`
above); a new named volume takes over the right owner and mode from the image.

- The container runs as the fixed user and group **65532:65532**, not as root. Runtimes that
  start containers with an arbitrary user ID (OpenShift, rootless Podman with user namespaces)
  need a volume that user owns with mode 0700: give the pod an `fsGroup` or `chown` the volume to
  the user it runs as.
- Kalzit refuses a data directory that others may read: a bind mount must belong to 65532 and have
  mode 0700, for example `sudo install -d -o 65532 -g 65532 -m 0700 /srv/kalzit`, then
  `-v /srv/kalzit:/var/lib/kalzit`.
- On Docker Desktop for Windows and macOS, use a named volume. A folder of the Windows or macOS
  host does not carry Linux owners and modes, and Kalzit refuses a database on a network or
  shared file system.
- Back up the volume as described under [Backups](../ARCHITECTURE.md#backups), together with the
  secrets key (below).

### Configuration

Settings come from `KALZIT_<SECTION>_<KEY>` environment variables, from a `kalzit.toml`, or both
(the variables win). Mount the file read-only at `/etc/kalzit/kalzit.toml`:

```sh
docker run -d --name kalzit -p 3000:3000 \
  -v kalzit-data:/var/lib/kalzit \
  -v "$PWD/kalzit.toml:/etc/kalzit/kalzit.toml:ro" \
  -e KALZIT_SERVER_PUBLIC_URL=https://kalzit.example.com \
  -e KALZIT_LOG_FORMAT=json \
  ghcr.io/mousewerk/kalzit:0.2
```

The image sets no configuration of its own: the defaults apply (`server.http_addr`
`0.0.0.0:3000`, data directory `/var/lib/kalzit`). Behind a reverse proxy, set
`server.public_url` to the address users open and add the proxy's network to
`security.trusted_proxies`. All settings are listed in the [README](../../README.md#configuration).
An environment variable that is set but empty unsets the file's value, so leave out the ones
you do not use.

### Secrets key

Kalzit encrypts data source passwords and tokens with a key. In a container it comes from, in
this order:

1. the environment variable `KALZIT_SECRETS_KEY` (base64 of 32 bytes);
2. a **Docker secret** named `kalzit-secrets-key`, mounted at `/run/secrets/kalzit-secrets-key`
   (the image reads `/run/secrets` like systemd credentials): 32 bytes, or their base64. This is
   the better choice: a secret does not show up in `docker inspect`;
3. otherwise a key file `secrets.key` in the volume, with a warning in the log.

Create a key with `openssl rand -base64 32`. The key is never part of the image. Keep a copy of
it with your backups: without it the stored data source secrets cannot be decrypted. On Linux,
the secret file must be readable by user 65532 inside the container (Compose mounts it as it is
on the host): `sudo chown 65532 secrets/kalzit-secrets-key && sudo chmod 0400
secrets/kalzit-secrets-key`.

**Changing the key.** A Docker secret is read-only in the container, so Kalzit cannot replace it
itself; `kalzit secrets rotate` re-encrypts the stored secrets with a new key you give it, and you
swap the file afterwards. With Compose (add `-f` with the file you started, for example
`-f compose.postgres.yaml`, to each `docker compose`):

```sh
openssl rand -base64 32 > secrets/kalzit-secrets-key.new
docker compose stop kalzit
docker compose run --rm -e KALZIT_SECRETS_NEW_KEY="$(cat secrets/kalzit-secrets-key.new)" \
  kalzit secrets rotate
mv secrets/kalzit-secrets-key secrets/kalzit-secrets-key.old
mv secrets/kalzit-secrets-key.new secrets/kalzit-secrets-key   # same owner and mode as before
docker compose up -d kalzit
```

Keep the old key as long as you keep backups taken before the change; they need it.

### Database URL

With PostgreSQL as Kalzit's own database, the URL holds the database password. Instead of
`KALZIT_DATABASE_URL`, which `docker inspect` shows, give Kalzit the URL in a file, in this
order:

1. `KALZIT_DATABASE_URL`, when it is set and not empty;
2. the file `KALZIT_DATABASE_URL_FILE` names;
3. a **Docker secret** named `kalzit-database-url` (`/run/secrets/kalzit-database-url`);
4. `database.url` in `kalzit.toml`.

The file holds one line, `postgres://kalzit:<password>@postgres:5432/kalzit`. Characters with a
meaning in a URL are percent-encoded in the password (`/` as `%2F`, `@` as `%40`, `+` as `%2B`);
a password from `openssl rand -hex 24` needs none. The log shows the URL with `***` for the
password, and SQLite data sources may not read the file. Like the key, the file must be readable
by user 65532.

### Compose

[deploy/docker](../../deploy/docker) has two Compose files and an `example.env`:

| File | Kalzit's own database |
|---|---|
| `compose.sqlite.yaml` | SQLite in the named volume `kalzit-data` |
| `compose.postgres.yaml` | PostgreSQL 17 in its own service with a health check; Kalzit starts once the database is healthy |

```sh
cd deploy/docker
cp example.env .env               # image, version and port
mkdir -p secrets
openssl rand -base64 32 > secrets/kalzit-secrets-key
password=$(openssl rand -hex 24)  # PostgreSQL only
printf '%s' "$password" > secrets/postgres-password
printf 'postgres://kalzit:%s@postgres:5432/kalzit\n' "$password" > secrets/kalzit-database-url
sudo chown 65532 secrets/kalzit-secrets-key secrets/kalzit-database-url   # Linux
sudo chmod 0400 secrets/kalzit-secrets-key secrets/kalzit-database-url
docker compose -f compose.postgres.yaml up -d
docker compose -f compose.postgres.yaml exec kalzit kalzit setup-code
```

Both files use the Docker secret `kalzit-secrets-key`. With PostgreSQL, the database password is
in no environment variable: PostgreSQL reads it from the secret `postgres-password`
(`POSTGRES_PASSWORD_FILE`), Kalzit reads the whole URL from the secret `kalzit-database-url`.
`.env` and `secrets/` are not checked in. Kalzit cannot back PostgreSQL up for you: use
`pg_dump`, and back the key up with it.

### Health check and stopping

The image's health check runs `kalzit healthcheck`, which asks `/readyz` on the plain HTTP
listener inside the container and passes when the database answers. `docker ps` shows the
container as `healthy` a few seconds after the start. It is a readiness check: while Kalzit's
own database is unreachable the container turns `unhealthy`, and an orchestrator that restarts
unhealthy containers restarts Kalzit. When you turn plain HTTP off
(`server.http_addr = ""`), the health check fails; keep HTTP on (with
`server.redirect_http_to_https`, `/healthz` and `/readyz` stay reachable over HTTP) or replace
the health check in your Compose file.

`docker stop` sends SIGTERM: Kalzit stops accepting requests, gives open ones 10 seconds and
closes the database cleanly. Docker's default of 10 seconds before it kills the process is
tight; the Compose files allow 30 (`stop_grace_period`), and `docker stop --time 30` does the
same.

### Updates

The built-in updater does not replace the program in a container: **Administration**
(Verwaltung) > **Updates** shows that a release is available and says to update the image
instead. Back up the volume (and the PostgreSQL database), then pull the new version and
recreate the container:

```sh
docker pull ghcr.io/mousewerk/kalzit:0.2
docker rm -f kalzit
docker run -d --name kalzit ...   # the same command as before
```

With Compose: `docker compose pull && docker compose up -d`. The new version migrates the
database on its first start. To go back, run the previous version's tag with the backup taken
before the update.

### Building the image

From a checkout of the repository:

```sh
docker build -t kalzit .
docker buildx build --platform linux/amd64,linux/arm64 -t kalzit .
```

The build compiles the web interface and the server; the server is cross-compiled for the other
architecture, so a multi-architecture build needs no emulation. Build arguments:
`CARGO_BUILD_JOBS` limits the parallel compile jobs, `KALZIT_BUILD_COMMIT` and
`KALZIT_BUILD_DATE` set what **Settings** > **About Kalzit** (Über Kalzit) shows (the build has no Git history).
