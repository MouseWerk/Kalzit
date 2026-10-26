# Installation

Kalzit is one program, `kalzit`, with the web interface built in. Run it as a container image, or
build the binary from source and run it directly or as a service (see the
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

Enter the code on the setup page, then name the organization and create the owner account, as
described in [Getting started](getting-started.md#first-setup). Once the owner exists, the code
is gone. To choose the code yourself (for automated installs), set `KALZIT_SETUP_TOKEN` to at
least 16 letters or digits.

### Data and the volume

Everything Kalzit keeps lives in `/var/lib/kalzit`, a volume: the SQLite database, the setup
code, the fallback key file and the update state. Keep it in a named volume (`kalzit-data`
above); a new named volume takes over the right owner and mode from the image.

- The container runs as the fixed user and group **65532:65532**, not as root.
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
secrets/kalzit-secrets-key`. To change the key later, see `kalzit secrets rotate` in the
[README](../../README.md#configuration).

### Compose

[deploy/docker](../../deploy/docker) has two Compose files and an `example.env`:

| File | Kalzit's own database |
|---|---|
| `compose.sqlite.yaml` | SQLite in the named volume `kalzit-data` |
| `compose.postgres.yaml` | PostgreSQL 17 in its own service with a health check; Kalzit starts once the database is healthy |

```sh
cd deploy/docker
cp example.env .env               # image, version, port; for PostgreSQL the database password
mkdir -p secrets
openssl rand -base64 32 > secrets/kalzit-secrets-key
docker compose -f compose.postgres.yaml up -d
docker compose -f compose.postgres.yaml exec kalzit kalzit setup-code
```

Both files use the Docker secret `kalzit-secrets-key` from `secrets/kalzit-secrets-key`. The
database password in `.env` takes letters and digits only (it becomes part of
`KALZIT_DATABASE_URL`), for example from `openssl rand -hex 24`. `.env` and `secrets/` are not
checked in. Kalzit cannot back PostgreSQL up for you: use `pg_dump`, and back the key up with it.

### Health check and stopping

The image's health check runs `kalzit healthcheck`, which asks `/readyz` on the plain HTTP
listener inside the container and passes when the database answers. `docker ps` shows the
container as `healthy` a few seconds after the start. When you turn plain HTTP off
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
