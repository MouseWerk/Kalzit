# syntax=docker/dockerfile:1

# The Kalzit container image: the web interface (Node) and the server (Rust) are built on the
# build machine's platform and the server is cross-compiled for the target, so a multi-arch build
# (linux/amd64, linux/arm64) needs no emulation. The runtime image is distroless: glibc, CA
# certificates and the `kalzit` binary, no shell, running as the fixed user 65532:65532.
#
#   docker build -t kalzit .
#   docker buildx build --platform linux/amd64,linux/arm64 -t kalzit .
#
# Build arguments: CARGO_PROFILE (release, or e2e for a faster CI build), CARGO_BUILD_JOBS (limit
# the parallel compile jobs), KALZIT_BUILD_COMMIT and KALZIT_BUILD_DATE (shown in Settings, About;
# the build context has no .git folder), VERSION, REVISION and CREATED (image labels).
# Installation and runtime conventions: docs/guide/installation.md, "Docker".

ARG RUST_IMAGE=rust:1-trixie
ARG NODE_IMAGE=node:26-trixie-slim
ARG RUNTIME_IMAGE=gcr.io/distroless/cc-debian13:nonroot

FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS node

# Rust and Node on the build platform, with a cross linker when the target differs. The license
# list of the web interface needs cargo next to npm.
FROM --platform=$BUILDPLATFORM ${RUST_IMAGE} AS base
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && node --version && npm --version
ARG TARGETARCH
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) triple=x86_64-unknown-linux-gnu; gnu=x86-64-linux-gnu; deb=amd64 ;; \
      arm64) triple=aarch64-unknown-linux-gnu; gnu=aarch64-linux-gnu; deb=arm64 ;; \
      *) echo "unsupported target architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    echo "$triple" > /rust-target; \
    if [ "$(rustc -vV | sed -n 's/^host: //p')" != "$triple" ]; then \
      apt-get update; \
      apt-get install -y --no-install-recommends "gcc-$gnu" "libc6-dev-$deb-cross"; \
      rm -rf /var/lib/apt/lists/*; \
      rustup target add "$triple"; \
    fi
# Debian names its compilers after the target (x86_64-linux-gnu-gcc exists on amd64 as well).
ENV CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER=x86_64-linux-gnu-gcc \
    CC_x86_64_unknown_linux_gnu=x86_64-linux-gnu-gcc \
    CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc \
    CC_aarch64_unknown_linux_gnu=aarch64-linux-gnu-gcc
WORKDIR /src

# The web interface, with the license files of exactly the crates the target binary links.
FROM base AS ui
COPY ui/package.json ui/package-lock.json ui/
RUN --mount=type=cache,target=/root/.npm,sharing=locked npm ci --prefix ui --no-audit --no-fund
COPY Cargo.toml Cargo.lock ./
COPY server server
COPY release release
COPY ui ui
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    cargo fetch --locked \
    && cd ui \
    && KALZIT_LICENSES_STRICT=1 KALZIT_LICENSES_TARGET="$(cat /rust-target)" npm run build

# The server binary with the web interface embedded.
FROM base AS server
COPY Cargo.toml Cargo.lock ./
COPY server server
COPY release release
COPY --from=ui /src/ui/dist ui/dist
ARG CARGO_PROFILE=release
ARG CARGO_BUILD_JOBS
ARG KALZIT_BUILD_COMMIT
ARG KALZIT_BUILD_DATE
# Public release keys trusted in addition to the compiled ones (docs/operations/updates.md).
ARG KALZIT_UPDATE_PUBLIC_KEYS
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/src/target,sharing=locked \
    set -eu; \
    for name in CARGO_BUILD_JOBS KALZIT_BUILD_COMMIT KALZIT_BUILD_DATE KALZIT_UPDATE_PUBLIC_KEYS; do \
      [ -n "$(printenv "$name" || true)" ] || unset "$name"; \
    done; \
    triple="$(cat /rust-target)"; \
    cargo build --locked --profile "$CARGO_PROFILE" --target "$triple" -p kalzit --bin kalzit; \
    install -D -m 0755 "target/$triple/$CARGO_PROFILE/kalzit" /out/usr/local/bin/kalzit; \
    install -d -m 0700 /out/data/kalzit

FROM ${RUNTIME_IMAGE}
ARG VERSION=dev
ARG REVISION=
ARG CREATED=
LABEL org.opencontainers.image.title="Kalzit" \
      org.opencontainers.image.description="Self-hosted platform to visualize and analyze data: dashboards, Explore, SQL, metrics, document and graph sources" \
      org.opencontainers.image.source="https://github.com/MouseWerk/Kalzit" \
      org.opencontainers.image.url="https://github.com/MouseWerk/Kalzit" \
      org.opencontainers.image.documentation="https://github.com/MouseWerk/Kalzit/blob/main/docs/guide/installation.md" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.vendor="MouseWerk" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}"
COPY --from=server /out/usr/local/bin/kalzit /usr/local/bin/kalzit
# The data directory belongs to the image's user; a new named volume takes it over.
COPY --from=server --chown=65532:65532 /out/data/ /var/lib/
# A Docker secret named kalzit-secrets-key (/run/secrets/kalzit-secrets-key) is read like a
# systemd credential; without it and without KALZIT_SECRETS_KEY, Kalzit keeps a key file in the
# data directory and warns. The folder is also closed to SQLite data sources.
ENV CREDENTIALS_DIRECTORY=/run/secrets
USER 65532:65532
# Not the data directory: a kalzit.toml in the working directory would be read before
# /etc/kalzit/kalzit.toml.
WORKDIR /
VOLUME ["/var/lib/kalzit"]
EXPOSE 3000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --start-interval=2s --retries=3 \
    CMD ["/usr/local/bin/kalzit", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/kalzit"]
CMD ["serve"]
