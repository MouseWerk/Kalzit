#!/usr/bin/env bash
# The Windows leg of the local CI, run by run.sh in Git Bash in a checkout of the commit under
# test. It mirrors the Windows jobs of .github/workflows/ci.yml; a change there belongs here too.
#
# Left out on purpose:
#   msi          installs Kalzit as a Windows service with a firewall rule on this machine; it
#                runs only with KALZIT_CI_MSI=1 (run.sh --msi; main-watch.sh passes it to the
#                full suite on main).
#   the e2e job's port range widening (netsh) and TCP watch, which change system settings.
#
# Environment: LOGS, AREAS, SRC (see common.sh), CARGO_TARGET_DIR, KALZIT_CI_CACHE,
# KALZIT_CI_LOCK, KALZIT_CI_STAGE, KALZIT_CI_ONLY (optional, see common.sh).

LEG=windows
# shellcheck source=common.sh
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"

export CARGO_TERM_COLOR=never RUSTFLAGS="-D warnings" CI=true TZ=UTC
# Both legs build at once on one machine (32 GB, 16 threads; WSL takes up to half the memory):
# with every thread each, linking the test binaries ran Windows out of memory (os error 1455).
# No incremental build either, as on CI runners: less memory and disk, the same results.
export CARGO_BUILD_JOBS=${KALZIT_CI_JOBS:-5} CARGO_INCREMENTAL=0
# Vitest takes half the threads by default (ui/vite.config.ts), next to the other leg's build;
# a timing-bound UI test then missed its wait. Four workers, about what a runner has.
TEST_WORKERS="--maxWorkers=${KALZIT_CI_TEST_WORKERS:-4}"
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
# The same for sccache and cargo-nextest when cargo installed them (README, Setup).
if ! command -v sccache > /dev/null && [ -x "$HOME/.cargo/bin/sccache.exe" ]; then
  export PATH="$PATH:$HOME/.cargo/bin"
fi
sccache_start

# The gate installs Chromium only (the smoke set runs there), the full suite all three.
e2e() {
  e2e_build
  local attempt browsers=(chromium firefox webkit)
  [ "$STAGE" = gate ] && browsers=(chromium)
  for attempt in 1 2 3; do
    (cd ui && npx playwright install "${browsers[@]}") && break
    echo "installing the browsers failed (attempt $attempt of 3)" >&2
    [ "$attempt" -lt 3 ] || return 1
  done
  local tools data env_file
  tools="$(cygpath -w "$KALZIT_CI_CACHE/e2e-services")"
  data="$(cygpath -w "$KALZIT_CI_CACHE/e2e-data")"
  env_file="$(mktemp)"
  pwsh -NoProfile -File .github/scripts/e2e-services.ps1 install -Tools "$tools" -Data "$data"
  services_lock
  # Only the servers the script started, by their recorded PIDs.
  # Expanded now: the trap runs after this function returned, when its locals are gone.
  trap "pwsh -NoProfile -File .github/scripts/e2e-services.ps1 stop -Tools '$tools' -Data '$data'; services_unlock; rm -f '$env_file'" EXIT
  pwsh -NoProfile -File .github/scripts/e2e-services.ps1 start -Tools "$tools" -Data "$data"
  GITHUB_ENV="$(cygpath -w "$env_file")" pwsh -NoProfile -File .github/scripts/e2e-services.ps1 ready -Tools "$tools" -Data "$data"
  load_env_file <(tr -d '\r' < "$env_file")
  e2e_playwright "$T/e2e/kalzit.exe" "$T/e2e/kalzit-test-plugin.exe"
}

# The installer of the e2e build the other jobs use (ci.yml builds `-p kalzit --bin kalzit`, which
# here would make a second build with other features).
msi() {
  e2e_build
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

# The UI checks (npm) run next to the server job (cargo). The gate stops after the smoke e2e.
job_bg ui ui -- ui
job server server -- server
wait_jobs
job sdk sdk -- sdk
job devkit devkit -- devkit
job devgen devgen server ui -- devgen
if [ "$STAGE" = gate ]; then
  job e2e e2e -- e2e
  skip_job plugins "full suite"
  skip_job msi "full suite"
  finish
  exit
fi
job plugins server -- plugins
job e2e e2e -- e2e
if [ "${KALZIT_CI_MSI:-0}" = 1 ]; then
  job msi installer -- msi
else
  skip_job msi "run.sh --msi"
fi
finish
