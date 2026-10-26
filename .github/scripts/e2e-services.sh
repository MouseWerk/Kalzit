#!/usr/bin/env bash
# MongoDB and OpenSearch for the end-to-end specs of document and search sources
# (ui/e2e/documents.spec.ts, ui/e2e/opensearch.spec.ts), on Linux runners only: Windows runners
# have no Linux containers, so there those specs are skipped and the Windows checklist covers
# them. Containers rather than job services, since services would also start on Windows.
#
#   e2e-services.sh start   pulls and starts both containers in the background (early in the job,
#                           so they are up by the time the build is done)
#   e2e-services.sh ready   waits for both, seeds MongoDB with ui/e2e/fixtures/mongo-orders.js and
#                           writes KALZIT_E2E_MONGODB and KALZIT_E2E_OPENSEARCH to $GITHUB_ENV
#
# The root password belongs to a throwaway container reachable only from this job; it protects
# nothing and is not a secret. Kalzit itself reads with the fixture's read-only login.
set -euo pipefail

MONGO=kalzit-e2e-mongo
OPENSEARCH=kalzit-e2e-opensearch
ROOT_PASSWORD=kalzit-e2e-root
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURE="$HERE/../../ui/e2e/fixtures/mongo-orders.js"

start() {
  docker run -d --name "$MONGO" -p 127.0.0.1:27017:27017 \
    -e MONGO_INITDB_ROOT_USERNAME=root -e MONGO_INITDB_ROOT_PASSWORD="$ROOT_PASSWORD" \
    mongo:8.2 > /dev/null
  docker run -d --name "$OPENSEARCH" -p 127.0.0.1:9201:9200 \
    -e discovery.type=single-node -e DISABLE_SECURITY_PLUGIN=true \
    -e DISABLE_INSTALL_DEMO_CONFIG=true \
    -e cluster.routing.allocation.disk.threshold_enabled=false \
    -e OPENSEARCH_JAVA_OPTS="-Xms512m -Xmx512m" \
    opensearchproject/opensearch:3.9.0 > /dev/null
  echo "started $MONGO and $OPENSEARCH"
}

mongosh_root() {
  docker exec -i "$MONGO" mongosh --quiet -u root -p "$ROOT_PASSWORD" --authenticationDatabase admin "$@"
}

ready() {
  for _ in $(seq 1 120); do
    if [ "${mongo:-}" != ok ] && mongosh_root --eval 'db.runCommand({ ping: 1 }).ok' > /dev/null 2>&1; then
      mongo=ok
    fi
    if [ "${os:-}" != ok ] \
      && curl -fs "http://127.0.0.1:9201/_cluster/health?wait_for_status=yellow&timeout=1s" > /dev/null; then
      os=ok
    fi
    if [ "${mongo:-}" = ok ] && [ "${os:-}" = ok ]; then
      mongosh_root < "$FIXTURE"
      {
        echo "KALZIT_E2E_MONGODB=127.0.0.1:27017"
        echo "KALZIT_E2E_OPENSEARCH=http://127.0.0.1:9201"
      } >> "$GITHUB_ENV"
      echo "MongoDB and OpenSearch are ready"
      return 0
    fi
    sleep 2
  done
  echo "MongoDB (${mongo:-not ready}) or OpenSearch (${os:-not ready}) did not become ready" >&2
  docker logs --tail 50 "$MONGO" >&2 || true
  docker logs --tail 50 "$OPENSEARCH" >&2 || true
  return 1
}

case "${1:-}" in
  start) start ;;
  ready) ready ;;
  *)
    echo "usage: $0 start|ready" >&2
    exit 2
    ;;
esac
