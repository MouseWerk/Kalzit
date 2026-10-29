# Installation

Kalzit is one program, `kalzit`, with the web interface built in. Run it as a container image
([Docker](#docker)), install it on Windows as a service with the MSI package ([Windows](#windows)),
or build the binary from source and run it directly or as a service (see the
[README](../../README.md#quick-start) and "Running as a service" in
[ARCHITECTURE](../ARCHITECTURE.md#running-as-a-service)). After the installation, continue with
[Getting started](getting-started.md).

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

## Windows

On Windows, Kalzit runs as the Windows service **Kalzit** under its own virtual account,
`NT SERVICE\Kalzit`. The MSI package sets everything up; `kalzit service install` does the same
without it.

### Installing with the MSI package

1. Download `kalzit-<version>-windows-x64.msi` from the
   [releases](https://github.com/MouseWerk/Kalzit/releases). Its SHA-256 is in
   `kalzit-<version>-manifest.json` of the same release, which is signed with Kalzit's release
   key: `Get-FileHash kalzit-<version>-windows-x64.msi` must show the same value.
2. Run it (it asks for administrator rights). The wizard asks for:

   | Page | Setting | Default |
   |---|---|---|
   | Destination folder | where `kalzit.exe` goes | `C:\Program Files\Kalzit` |
   | Server settings | HTTP port | `3000` |
   | | data folder | `%ProgramData%\Kalzit\data` |
   | | HTTPS: off, a self-signed certificate for this computer, or an existing certificate (PEM files) | off |
   | | HTTPS port, certificate file and key file | `3443` |
   | | open the port(s) in Windows Defender Firewall | not ticked |

3. When it is done, open `http://localhost:3000` (or the port you chose). The setup code for the
   first sign-in: open PowerShell or a command prompt with **Run as administrator** and run
   `kalzit setup-code`. Continue with [Getting started](getting-started.md#first-setup).

What the package sets up:

- `kalzit.exe` in the program folder, which is added to the system `PATH`.
- The service `Kalzit` (automatic start, account `NT SERVICE\Kalzit`). After a failure the service
  manager starts it again (after 2 s, 5 s, then every 30 s).
- `%ProgramData%\Kalzit\kalzit.toml` with your settings. Everyone may read it, only
  Administrators may change it.
- The data folder, with access for Administrators and the service account only. It holds the
  database, the setup code, the key for stored passwords (`secrets.key.dpapi`, protected with
  DPAPI for this computer), the log and, with a self-signed certificate, `tls\`.
- With "Existing certificate", the service account may read the two files where they are. A
  renewed certificate saved over them takes effect within a minute, without a restart.
- With the firewall ticked, an inbound rule named `Kalzit` for the port(s).

A self-signed certificate (`<data folder>\tls\self-signed.crt.pem`) makes browsers warn until
you trust it on each computer that opens Kalzit; for more than a test, use a certificate from your
own certificate authority or a public one.

If `%ProgramData%\Kalzit\kalzit.toml` exists already (an earlier installation), the package keeps
it and skips the settings page.

### Silent installation

Every setting is an MSI property:

```powershell
msiexec /i kalzit-0.5.0-windows-x64.msi /qn /l*v kalzit-install.log PORT=8080 FIREWALL=1
msiexec /i kalzit-0.5.0-windows-x64.msi /qn HTTPS=certificate HTTPSPORT=443 `
  CERTFILE="C:\certs\kalzit.pem" KEYFILE="C:\certs\kalzit.key" DATADIR="D:\Kalzit"
```

| Property | Meaning | Default |
|---|---|---|
| `INSTALLFOLDER` | program folder | `C:\Program Files\Kalzit` |
| `PORT` | HTTP port | `3000` |
| `DATADIR` | data folder (absolute path) | `%ProgramData%\Kalzit\data` |
| `HTTPS` | `off`, `self-signed` or `certificate` | `off` |
| `HTTPSPORT` | HTTPS port | `3443` |
| `CERTFILE`, `KEYFILE` | certificate chain and private key (PEM) for `HTTPS=certificate` | |
| `FIREWALL` | `1` opens the port(s) in Windows Defender Firewall | not set |
| `SELFUPDATE` | `1`: the service account may replace `kalzit.exe`, so updates install on their own; `0`: the program folder stays for Administrators only | `1` |
| `REMOVEDATA` | when uninstalling: `1` also removes the data folder and `kalzit.toml` | not set |

With an existing `kalzit.toml`, `PORT`, `DATADIR` and the HTTPS properties are not used. When
something goes wrong, the log (`/l*v`) and the Windows event log (Event Viewer, Windows Logs,
Application, source `Kalzit`) say what.

### Without the MSI package

`kalzit service` sets up the same service for a `kalzit.exe` you copied yourself. Copy it to a
folder only Administrators can change, such as `C:\Program Files\Kalzit` (Kalzit refuses a folder
others may change, since the service runs what is in it), then in an elevated prompt:

```powershell
& "C:\Program Files\Kalzit\kalzit.exe" service install --port 3000 --open-firewall
```

| Command | What it does |
|---|---|
| `kalzit service install` | creates the service for this `kalzit.exe`, writes `kalzit.toml` (unless it exists), secures the data folder and starts the service. Options as the properties above: `--port`, `--data-dir`, `--https` (`off`, `self-signed` or `certificate`), `--https-port`, `--cert-file`, `--key-file`, `--open-firewall`, `--self-update 0`; `--no-start` sets up without starting; `--config` uses another configuration file than `%ProgramData%\Kalzit\kalzit.toml` |
| `kalzit service uninstall` | stops and removes the service and the firewall rule; the data and `kalzit.toml` stay. `--remove-data` removes them too |
| `kalzit service run` | what the service manager starts; in a console, use `kalzit serve` |

Do not mix the two ways: uninstall an MSI installation in Settings, Apps, and a
`kalzit service install` with `kalzit service uninstall`.

### Running the service

- Start, stop and restart it in the Services app, or in an elevated PowerShell with
  `Start-Service Kalzit`, `Stop-Service Kalzit` and `Restart-Service Kalzit`. Stopping finishes
  open requests (up to 10 seconds) and closes the database cleanly.
- The log is `<data folder>\logs\kalzit.log` (a new file every 10 MB, three older ones kept).
  Errors before that file can be written, such as a broken `kalzit.toml`, are in the Windows event
  log (Application, source `Kalzit`).
- To change a setting, edit `%ProgramData%\Kalzit\kalzit.toml` as an administrator and restart
  the service. All settings are listed in the [README](../../README.md#configuration).
- The key for stored passwords is `secrets.key.dpapi` in the data folder, which only this
  computer can decrypt: back the data folder up as a whole ([Backups](../ARCHITECTURE.md#backups)),
  and after restoring it on another computer, enter the data source passwords again.

### Updates

- **The built-in updater** (Administration (Verwaltung) > Updates) installs on its own when Kalzit
  runs as the service with self-update on (the default): it stops the service gracefully, backs
  up the database, puts the new `kalzit.exe` in place and the service manager starts it again. If
  the new version does not report healthy, Kalzit returns to the previous one with the backup
  ([Updates guide](../operations/updates.md)). Settings, Apps keeps showing the version the MSI
  package installed; the Updates page shows the one that runs.
- **A newer MSI package** installs over the previous one: the service stops, the program is
  replaced, the service starts again; `kalzit.toml` and the data stay. The new version migrates
  the database on its first start, without the updater's backup and automatic return, so back up
  the data folder first ([Backups](../ARCHITECTURE.md#backups)). An older package than the one
  installed is refused.
- With `SELFUPDATE=0`, the Updates page downloads and verifies, and you install from an elevated
  prompt: `Stop-Service Kalzit`, `kalzit update apply`, `Start-Service Kalzit`, or with the next MSI
  package.

### Uninstalling

- Settings, Apps, Kalzit, **Uninstall** removes the program, the service and the firewall rule.
  The data folder and `kalzit.toml` stay, so a later installation finds everything again.
- To remove the data too, run the MSI package again, choose **Remove** and tick "Also remove the
  data folder and the configuration", or run
  `msiexec /x kalzit-<version>-windows-x64.msi REMOVEDATA=1`. This cannot be undone. A data folder
  that holds other files than Kalzit's (or a drive root) is left in place.

### Signed packages

Release packages are signed with the project's code-signing certificate when one is set up for
the release; Windows then names the publisher before it installs. Unsigned packages say so in the
release notes, and Windows SmartScreen may warn ("Windows protected your PC"): compare the SHA-256
with the signed manifest as above, then choose "More info" and "Run anyway".
