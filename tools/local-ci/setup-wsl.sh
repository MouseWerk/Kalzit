#!/usr/bin/env bash
# Prepares the WSL distribution (Ubuntu) for the Linux leg of the local CI. Run once as root,
# and again after a toolchain change; every step is safe to repeat:
#
#   wsl.exe -d Ubuntu -u root -- bash tools/local-ci/setup-wsl.sh
#
# Installs: build tools, jq, Go (pebble for the acme job), Rust stable with rustfmt and clippy,
# cargo-audit, Node 26, and Docker Engine inside the distribution (the leg does not use Docker
# Desktop). Windows' PATH is left out of the distribution (appendWindowsPath=false), so Windows'
# node, npm and docker never stand in for the Linux ones; that takes effect after
# `wsl --terminate Ubuntu`.

set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update -qq
apt-get install -y -qq build-essential pkg-config libssl-dev clang git curl ca-certificates unzip \
  xz-utils jq golang-go docker.io docker-compose-v2 > /dev/null
systemctl enable --now docker > /dev/null 2>&1 || service docker start

if [ ! -x "$HOME/.cargo/bin/rustup" ]; then
  curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal > /dev/null
fi
# shellcheck disable=SC1091
. "$HOME/.cargo/env"
rustup default stable > /dev/null
rustup update stable > /dev/null
rustup component add rustfmt clippy > /dev/null
command -v cargo-audit > /dev/null || cargo install --locked cargo-audit > /dev/null

if ! node --version 2> /dev/null | grep -q '^v26'; then
  curl -fsSL https://deb.nodesource.com/setup_26.x | bash - > /dev/null
  apt-get install -y -qq nodejs > /dev/null
fi

if ! grep -q appendWindowsPath /etc/wsl.conf 2> /dev/null; then
  printf '\n[interop]\nappendWindowsPath=false\n' >> /etc/wsl.conf
fi

echo "cargo $(cargo --version | cut -d' ' -f2), node $(node --version), go $(go version | cut -d' ' -f3), $(docker --version)"
