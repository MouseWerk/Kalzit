#!/usr/bin/env bash
# Smoke test of a built Kalzit image (docker-smoke.sh IMAGE:TAG):
#
# 1. alone, with SQLite in a named volume: becomes healthy through `kalzit healthcheck`, runs as
#    65532:65532, answers /readyz, the first-run page and /api/setup, prints the setup code with
#    `kalzit setup-code`, falls back to a key file in the volume, and stops cleanly on SIGTERM;
# 2. from deploy/docker/compose.postgres.yaml, with PostgreSQL and the secrets key as a Docker
#    secret: becomes healthy and does not fall back to a key file.
#
# Ports 18300 and 18301 on loopback; everything it creates is removed again.
set -euo pipefail

image=${1:?usage: docker-smoke.sh IMAGE:TAG}
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
name=kalzit-smoke
volume=kalzit-smoke-data
project=kalzit-smoke-compose
work=$(mktemp -d)
compose=(docker compose --project-name "$project" --project-directory "$work" -f "$work/compose.postgres.yaml")

cleanup() {
  if docker inspect "$name" > /dev/null 2>&1; then
    docker rm -f "$name" > /dev/null || true
  fi
  docker volume rm "$volume" > /dev/null 2>&1 || true
  if [ -f "$work/compose.postgres.yaml" ]; then
    "${compose[@]}" down --volumes --timeout 30 > /dev/null 2>&1 || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT

fail() {
  echo "::error::$1"
  exit 1
}

# Waits until the container's health check passes; fails when it reports unhealthy or stops.
wait_healthy() {
  local container=$1 status
  for _ in $(seq 1 120); do
    status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container")
    case "$status" in
      healthy) return 0 ;;
      unhealthy)
        docker logs "$container" 2>&1 | tail -n 50
        fail "$container became unhealthy" ;;
    esac
    if [ "$(docker inspect -f '{{.State.Running}}' "$container")" != true ]; then
      docker logs "$container" 2>&1 | tail -n 50
      fail "$container stopped"
    fi
    sleep 2
  done
  docker logs "$container" 2>&1 | tail -n 50
  fail "$container did not become healthy in 4 minutes"
}

echo "== $image alone, SQLite in a named volume"
[ "$(docker image inspect -f '{{.Config.User}}' "$image")" = 65532:65532 ] || fail "the image does not run as 65532:65532"
docker run -d --name "$name" -p 127.0.0.1:18300:3000 -v "$volume:/var/lib/kalzit" "$image" > /dev/null
wait_healthy "$name"
curl -fsS http://127.0.0.1:18300/readyz | grep -qx ready || fail "/readyz did not answer ready"
curl -fsS http://127.0.0.1:18300/ | grep -qi '<html' || fail "the first-run page did not answer"
curl -fsS http://127.0.0.1:18300/api/setup | grep -q '"needed":true' || fail "/api/setup does not ask for setup"
code=$(docker exec "$name" kalzit setup-code)
[[ "$code" =~ ^[0-9a-f]{4}(-[0-9a-f]{4}){5}$ ]] || fail "kalzit setup-code printed '$code'"
logs=$(docker logs "$name" 2>&1)
grep -q 'setup code from /var/lib/kalzit/setup-token.txt' <<< "$logs" || fail "the log does not point to the setup code"
grep -q 'stored without OS protection in /var/lib/kalzit/secrets.key' <<< "$logs" \
  || fail "without a key the server did not fall back to a key file in the volume"
docker stop --time 30 "$name" > /dev/null
[ "$(docker inspect -f '{{.State.ExitCode}}' "$name")" = 0 ] || fail "the server did not stop cleanly on SIGTERM"
docker rm "$name" > /dev/null
echo "ok"

echo "== $image from compose.postgres.yaml, PostgreSQL and a Docker secret"
cp "$repo_root/deploy/docker/compose.postgres.yaml" "$repo_root/deploy/docker/compose.sqlite.yaml" "$work/"
mkdir "$work/secrets"
head -c 32 /dev/urandom | base64 > "$work/secrets/kalzit-secrets-key"
chmod 0644 "$work/secrets/kalzit-secrets-key"
{
  echo "KALZIT_IMAGE=${image%:*}"
  echo "KALZIT_VERSION=${image##*:}"
  echo "KALZIT_PORT=18301"
  echo "KALZIT_DB_PASSWORD=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
} > "$work/.env"
docker compose --project-directory "$work" -f "$work/compose.sqlite.yaml" config --quiet
"${compose[@]}" config --quiet
"${compose[@]}" up -d --wait --wait-timeout 240 || {
  "${compose[@]}" logs --tail 50
  fail "compose.postgres.yaml did not become healthy"
}
curl -fsS http://127.0.0.1:18301/readyz | grep -qx ready || fail "/readyz did not answer ready (PostgreSQL)"
curl -fsS http://127.0.0.1:18301/api/setup | grep -q '"needed":true' || fail "/api/setup does not ask for setup (PostgreSQL)"
"${compose[@]}" exec -T kalzit kalzit setup-code > /dev/null || fail "kalzit setup-code failed (PostgreSQL)"
logs=$("${compose[@]}" logs kalzit 2>&1)
if grep -q 'stored without OS protection' <<< "$logs"; then
  fail "the Docker secret kalzit-secrets-key was not used"
fi
"${compose[@]}" stop --timeout 30 kalzit > /dev/null
echo "ok"
