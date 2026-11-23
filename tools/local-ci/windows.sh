#!/usr/bin/env bash
# The Windows leg of the local CI, run by run.sh in Git Bash in a checkout of the commit under
# test. It mirrors the Windows jobs of .github/workflows/ci.yml; a change there belongs here too.
#
# Left out on purpose:
#   msi          installs Kalzit as a Windows service with a firewall rule on this machine; it
#                runs only with KALZIT_CI_MSI=1 (run.sh --msi), for example before a release.
#   the e2e job's port range widening (netsh) and TCP watch, which change system settings.
#
# Environment: LOGS, AREAS, SRC (see common.sh), CARGO_TARGET_DIR, KALZIT_CI_CACHE,
# KALZIT_CI_LOCK (optional).

LEG=windows
# shellcheck source=common.sh
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"

export CARGO_TERM_COLOR=never RUSTFLAGS="-D warnings" CI=true TZ=UTC
: "${CARGO_TARGET_DIR:?}" "${KALZIT_CI_CACHE:?}"
T=$CARGO_TARGET_DIR
PLATFORM=windows-x64
EXE=.exe
mkdir -p "$KALZIT_CI_CACHE"
export PLAYWRIGHT_BROWSERS_PATH="$KALZIT_CI_CACHE/playwright"
# A base64 public key can start with "/", which Git Bash would turn into a path.
export MSYS_NO_PATHCONV=1
# Go's installer puts it here; a shell started before the install does not have it on PATH yet.
if ! command -v go > /dev/null && [ -x "/c/Program Files/Go/bin/go.exe" ]; then
  export PATH="$PATH:/c/Program Files/Go/bin"
fi

server() {
  cargo fmt --all --check
  cargo clippy --locked --all-targets -- -D warnings
  cargo test --locked
}

ui() {
  cd ui
  npm ci --no-audit --no-fund
  npm run format:check
  npm run lint
  npm run check
  npm run typecheck
  npm test
  KALZIT_LICENSES_STRICT=0 npm run build
  npm run budget
}

devkit() {
  cd tools/devkit
  npm ci --no-audit --no-fund
  npm run check
  npm run typecheck
  npm test
  npm run build
}

devgen() {
  cd tools/devgen
  npm ci --no-audit --no-fund
  npm run check
  npm run typecheck
  npm test
}

E2E_BUILT=false
e2e_build() {
  if [ "$E2E_BUILT" != true ]; then
    (cd ui && npm ci --no-audit --no-fund && npm run build)
    cargo build --profile e2e --locked -p kalzit -p kalzit-test-plugin
    E2E_BUILT=true
  fi
}

e2e() {
  e2e_build
  (cd ui && npx playwright install chromium firefox webkit)
  local tools data env_file
  tools="$(cygpath -w "$KALZIT_CI_CACHE/e2e-services")"
  data="$(cygpath -w "$KALZIT_CI_CACHE/e2e-data")"
  env_file="$(mktemp)"
  pwsh -NoProfile -File .github/scripts/e2e-services.ps1 install -Tools "$tools" -Data "$data"
  services_lock
  # Only the servers the script started, by their recorded PIDs.
  trap 'pwsh -NoProfile -File .github/scripts/e2e-services.ps1 stop -Tools "$tools" -Data "$data"; services_unlock; rm -f "$env_file"' EXIT
  pwsh -NoProfile -File .github/scripts/e2e-services.ps1 start -Tools "$tools" -Data "$data"
  GITHUB_ENV="$(cygpath -w "$env_file")" pwsh -NoProfile -File .github/scripts/e2e-services.ps1 ready -Tools "$tools" -Data "$data"
  load_env_file <(tr -d '\r' < "$env_file")
  local run_dir="$KALZIT_CI_CACHE/e2e-run"
  rm -rf "$run_dir"
  local status=0
  (cd ui && KALZIT_E2E_BINARY="$(cygpath -w "$T/e2e/kalzit.exe")" \
    KALZIT_E2E_PLUGIN_BINARY="$(cygpath -w "$T/e2e/kalzit-test-plugin.exe")" \
    KALZIT_E2E_RUN_DIR="$(cygpath -w "$run_dir")" npm run e2e) || status=$?
  if [ "$status" -ne 0 ] && [ -d ui/e2e/.output ]; then
    cp -r ui/e2e/.output "$LOGS/windows-e2e-output" || true
  fi
  return "$status"
}

msi() {
  cargo build --profile e2e --locked -p kalzit --bin kalzit
  local exe dist logs
  exe="$(cygpath -w "$T/e2e/kalzit.exe")"
  dist="$(cygpath -w "$(mktemp -d)")"
  logs="$(cygpath -w "$LOGS/windows-msi-logs")"
  command -v wix > /dev/null || {
    dotnet tool install --global wix --version 5.0.2
    wix extension add --global WixToolset.UI.wixext/5.0.2
  }
  pwsh -NoProfile -Command "
    \$ErrorActionPreference = 'Stop'
    \$version = (Select-String -Path server/Cargo.toml -Pattern '^version = \"(.+)\"' | Select-Object -First 1).Matches[0].Groups[1].Value
    ./packaging/windows/build.ps1 -Exe '$exe' -Version \$version -Out '$dist\\kalzit-ci-windows-x64.msi'
    ./packaging/windows/check-msi.ps1 -Msi '$dist\\kalzit-ci-windows-x64.msi' -Exe '$exe'
    \$parts = (\$version -replace '[-+].*$', '').Split('.')
    \$next = \"\$(\$parts[0]).\$(\$parts[1]).\$([int]\$parts[2] + 1)\"
    ./packaging/windows/build.ps1 -Exe '$exe' -Version \$next -Out '$dist\\kalzit-ci-next-windows-x64.msi'
    ./.github/scripts/msi-test.ps1 -Msi '$dist\\kalzit-ci-windows-x64.msi' -UpgradeMsi '$dist\\kalzit-ci-next-windows-x64.msi' -Exe '$exe' -Logs '$logs'
  "
}

job server server -- server
job plugins server -- plugins
job ui ui -- ui
job sdk sdk -- sdk
job devkit devkit -- devkit
job devgen devgen server ui -- devgen
job e2e e2e -- e2e
if [ "${KALZIT_CI_MSI:-0}" = 1 ]; then
  job msi installer -- msi
else
  SUMMARY+=("skipped  msi (run.sh --msi)")
fi
finish
