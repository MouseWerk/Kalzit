#!/usr/bin/env bash
# Frees disk space on a GitHub-hosted Linux runner before a Rust build: the image ships toolchains
# Kalzit never uses (.NET, Android, Haskell, CodeQL), and debug test binaries plus their linking
# otherwise run the disk full ("ld terminated with signal 7 [Bus error]").
set -euo pipefail
df -h / | tail -1
sudo rm -rf /usr/share/dotnet /usr/local/lib/android /opt/ghc /usr/local/.ghcup \
  /opt/hostedtoolcache/CodeQL /usr/local/share/boost /usr/local/share/powershell
df -h / | tail -1
