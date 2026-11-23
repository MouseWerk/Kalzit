#!/usr/bin/env bash
# Prepares the WSL distribution (Ubuntu) for the Linux leg of the local CI. Run once as root,
# and again after a toolchain change; every step is safe to repeat:
#
#   wsl.exe -d Ubuntu -u root -- bash tools/local-ci/setup-wsl.sh
#
# Installs: build tools, jq, Go (pebble for the acme job), Node 26, and Docker Engine inside the
# distribution (the leg does not use Docker Desktop). The leg runs as the user `ci`, as GitHub's
# runner runs as a user of its own: Kalzit refuses to run plugins as root. `ci` may use sudo
# without a password (the jobs that use sudo in ci.yml, and the browsers' system packages) and
# Docker, and has its own Rust stable with rustfmt, clippy and cargo-audit. Windows' PATH is left
# out of the distribution (appendWindowsPath=false), so Windows' node, npm and docker never stand
# in for the Linux ones; that takes effect after `wsl --terminate Ubuntu`.

set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update -qq
apt-get install -y -qq build-essential pkg-config libssl-dev clang git curl ca-certificates unzip \
  xz-utils jq golang-go docker.io docker-compose-v2 docker-buildx sudo > /dev/null
systemctl enable --now docker > /dev/null 2>&1 || service docker start

if ! node --version 2> /dev/null | grep -q '^v26'; then
  curl -fsSL https://deb.nodesource.com/setup_26.x | bash - > /dev/null
  apt-get install -y -qq nodejs > /dev/null
fi

# The user the leg runs as.
id ci > /dev/null 2>&1 || useradd --create-home --shell /bin/bash ci
usermod -aG docker ci
printf 'ci ALL=(ALL) NOPASSWD: ALL\n' > /etc/sudoers.d/kalzit-ci
chmod 0440 /etc/sudoers.d/kalzit-ci
visudo -cf /etc/sudoers.d/kalzit-ci > /dev/null

# A checkout and build cache from when the leg ran as root move over instead of building anew.
for folder in kz-ci kz-target; do
  if [ -d "/root/$folder" ] && [ ! -e "/home/ci/$folder" ]; then
    mv "/root/$folder" "/home/ci/$folder"
    chown -R ci:ci "/home/ci/$folder"
  fi
done

sudo -u ci -H bash -euo pipefail -c '
  if [ ! -x "$HOME/.cargo/bin/rustup" ]; then
    curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal > /dev/null
  fi
  . "$HOME/.cargo/env"
  rustup default stable > /dev/null
  rustup update stable > /dev/null
  rustup component add rustfmt clippy > /dev/null
  command -v cargo-audit > /dev/null || cargo install --locked cargo-audit > /dev/null
  echo "ci: cargo $(cargo --version | cut -d" " -f2)"
'

if ! grep -q appendWindowsPath /etc/wsl.conf 2> /dev/null; then
  printf '\n[interop]\nappendWindowsPath=false\n' >> /etc/wsl.conf
fi

echo "node $(node --version), go $(go version | cut -d' ' -f3), $(docker --version)"
