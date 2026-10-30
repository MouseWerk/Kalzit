# Installation

Kalzit is one program, `kalzit`, with the web interface built in. On Linux, install the deb or
rpm package, which runs it as a systemd service; on Windows, install it as a service with the MSI
package ([Windows](#windows)); or run it as a container image ([Docker](#docker)); or build the
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
An existing account named `kalzit` is used only when it is a system account without a login
shell and its group `kalzit` has no other members; otherwise the installation stops with a
message, so a person's account never ends up owning Kalzit's data.
The unit is hardened: the file system is read-only except the data directory
(`ProtectSystem=strict`, `ReadWritePaths=/var/lib/kalzit`), no new privileges, no access to
home directories, devices, kernel settings or other processes, and a system call filter. It
keeps what the plugin sandbox needs (user, IPC and network namespaces, Landlock, seccomp);
`sudo -u kalzit kalzit sandbox-check` lists the protections plugins get on this system, and the
packages' tests check that the unit takes none of them away. Ubuntu 23.10 and later refuse user
namespaces to programs without an AppArmor profile that allows them; the deb therefore installs
`/etc/apparmor.d/kalzit`, which allows them for `/usr/bin/kalzit` and confines nothing else, and
loads it when AppArmor is active (`apt purge` deletes it). The service may bind ports below 1024
(`CAP_NET_BIND_SERVICE`), so HTTPS on 443 and HTTP on 80 work without root; plugins never get
that capability.

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

   The wizard is in German when Windows shows German, otherwise in English; to choose German on
   any Windows, start it with `msiexec /i kalzit-<version>-windows-x64.msi TRANSFORMS=:1031`.

3. When it is done, open `http://localhost:3000` (or the port you chose). The setup code for the
   first sign-in is in `setup-token.txt` in the data folder, which only administrators can open:
   in PowerShell opened with **Run as administrator**,
   `Get-Content C:\ProgramData\Kalzit\data\setup-token.txt`. Continue with
   [Getting started](getting-started.md#first-setup).

What the package sets up:

- `kalzit.exe` in the program folder. Only Administrators and SYSTEM may change the folder (with
  `SELFUPDATE=1` also the service account); everyone may run the program. The folder is not added
  to `PATH`: call `kalzit.exe` with its full path. The installer's own steps run from a copy of
  the program inside the package, never from the installed file.
- The service `Kalzit` (automatic start, account `NT SERVICE\Kalzit`) with a single privilege,
  `SeChangeNotifyPrivilege`: no impersonation, so a compromised service cannot turn itself into
  SYSTEM. After a failure the service manager starts it again (after 2 s, 5 s, then every 30 s).
- `%ProgramData%\Kalzit\kalzit.toml` with your settings. Everyone may read it, only
  Administrators may change it.
- The data folder, with access for Administrators and the service account only. It holds the
  database, the setup code, the key for stored passwords (`secrets.key.dpapi`, protected with
  DPAPI for this computer), the log and, with a self-signed certificate, `tls\`.
- With "Existing certificate", the service account may read the two files where they are. A
  renewed certificate saved over them takes effect within a minute, without a restart. Both must
  be files only Administrators may change, the key also one only they may read, in folders others
  cannot rename (a key under `C:\` or one Users may read is refused); otherwise restrict them, or
  copy them into a folder only Administrators can open.
- With the firewall ticked, an inbound rule named `Kalzit` for the port(s).

A self-signed certificate (`<data folder>\tls\self-signed.crt.pem`) makes browsers warn until
you trust it on each computer that opens Kalzit; for more than a test, use a certificate from your
own certificate authority or a public one.

If `%ProgramData%\Kalzit\kalzit.toml` exists already (an earlier installation), the package keeps
it and skips the settings page.

The installer does not take over what someone else could have prepared, since the service would
run, restore or serve it. The installation stops, and the message in the installer's log and the
event log says what, when:

- `%ProgramData%\Kalzit` exists, but others than Administrators may change it, or `kalzit.toml`
  was not written by an administrator;
- the data folder exists, but someone else owns or may open a file or folder in it, or it holds a
  link or junction;
- the data folder is a drive root, a system folder (Windows, Program Files, `%ProgramData%`
  itself, `C:\Users`) or lies in the program folder;
- a folder above the data folder, the program folder or the certificate lets others rename or
  remove what is in it (folders created directly under `C:\` are like that, `C:\Program Files`
  and `%ProgramData%` are not);
- the program folder holds anything else than Kalzit's files, or others may change it.

Move such a folder aside (or fix its access list) and install again.

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
| `SELFUPDATE` | `0`: the program folder stays for Administrators only, and updates come with a new MSI package; `1`: the service account may replace `kalzit.exe`, so the built-in updater installs on its own (see the note below) | `0` |
| `REMOVEDATA` | when uninstalling: `1` also removes the data folder and `kalzit.toml` | not set |

**`SELFUPDATE=1` and its risk.** With it, the service account may change `kalzit.exe` and what lies
next to it. Should the service ever be taken over, the attacker could change code that an
administrator later runs with full rights, and so become an administrator. Kalzit loads DLLs only
from System32 and the installer never runs the installed file, but an administrator who starts
that `kalzit.exe` elevated (for `kalzit update`, `kalzit setup-code`, `kalzit service`) runs what
the service account left there. With `SELFUPDATE=1`, do not run the installed program elevated:
read the setup code from `setup-token.txt`, and use a `kalzit.exe` downloaded from the release for
command-line work. With `SELFUPDATE=0` (the default) running it elevated is safe.

With an existing `kalzit.toml`, `PORT`, `DATADIR` and the HTTPS properties are not used. Values
must not contain a quote (`"`). The settings are read at the first installation and at upgrades,
never at a repair. When something goes wrong, the log (`/l*v`) and the Windows event log (Event
Viewer, Windows Logs, Application, source `Kalzit`) say what.

### Without the MSI package

`kalzit service` sets up the same service for a `kalzit.exe` you copied yourself. Copy it alone
into a folder of its own that only Administrators can change, such as `C:\Program Files\Kalzit`
(Kalzit refuses a folder others may change or one with other files in it, since the service runs
what is in it), then in an elevated prompt:

```powershell
& "C:\Program Files\Kalzit\kalzit.exe" service install --port 3000 --open-firewall
```

| Command | What it does |
|---|---|
| `kalzit service install` | creates the service for this `kalzit.exe`, writes `kalzit.toml` (unless it exists), secures the data folder and starts the service. Options as the properties above: `--port`, `--data-dir`, `--https` (`off`, `self-signed` or `certificate`), `--https-port`, `--cert-file`, `--key-file`, `--open-firewall`, `--self-update 1` (off by default, see the note on `SELFUPDATE`); `--no-start` sets up without starting; `--config` uses another configuration file than `%ProgramData%\Kalzit\kalzit.toml` |
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
  the service. All settings are listed in the [README](../../README.md#configuration). Everyone on
  the computer may read the file, so put no secrets into it: give a PostgreSQL URL with a password
  in a file named by `KALZIT_DATABASE_URL_FILE` that only Administrators and the service may read.
  Kalzit warns in its log and in Settings, About (for server administrators) when `database.url`
  in the file holds a password.
- The key for stored passwords is `secrets.key.dpapi` in the data folder, which only this
  computer can decrypt: back the data folder up as a whole ([Backups](../ARCHITECTURE.md#backups)),
  and after restoring it on another computer, enter the data source passwords again.

### Updates

- **A newer MSI package** (the default way) installs over the previous one: the service stops, the
  program is replaced, the service starts again; `kalzit.toml` and the data stay. The new version
  migrates the database on its first start, without the updater's backup and automatic return,
  so back up the data folder first ([Backups](../ARCHITECTURE.md#backups)). An older package than
  the one installed is refused. The Updates page (Administration (Verwaltung) > Updates) tells you
  when a release is out; it can also download and verify it for `kalzit update apply` from an
  elevated prompt (`Stop-Service Kalzit`, `& "C:\Program Files\Kalzit\kalzit.exe" update apply`,
  `Start-Service Kalzit`).
- **The built-in updater installs on its own** only with `SELFUPDATE=1` (see the note on its
  risk above): it stops the service gracefully, backs up the database, puts the new `kalzit.exe`
  in place and the service manager starts it again. If the new version does not report healthy,
  Kalzit returns to the previous one with the backup ([Updates guide](../operations/updates.md)).
  Settings, Apps keeps showing the version the MSI package installed; the Updates page shows the
  one that runs.

### Uninstalling

- Settings, Apps, Kalzit, **Uninstall** removes the program, the service and the firewall rule.
  The data folder and `kalzit.toml` stay, so a later installation finds everything again.
- To remove the data too, run the MSI package again, choose **Remove** and tick "Also remove the
  data folder and the configuration", or run
  `msiexec /x kalzit-<version>-windows-x64.msi REMOVEDATA=1`. This cannot be undone. A data folder
  that holds other files than Kalzit's (or a drive root), lies behind a link or junction, or sits
  in a folder others may change is left in place.

### Signed packages

Release packages are signed with the project's code signing (Microsoft Artifact Signing or a
code-signing certificate) when it is set up for the release; Windows then names the publisher
before it installs. Unsigned packages say so in the
release notes, and Windows SmartScreen may warn ("Windows protected your PC"): compare the SHA-256
with the signed manifest as above, then choose "More info" and "Run anyway".
