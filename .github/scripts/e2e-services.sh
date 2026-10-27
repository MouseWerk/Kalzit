#!/usr/bin/env bash
# MongoDB, OpenSearch, Neo4j and Memgraph for the end-to-end specs of document, search and graph
# sources (ui/e2e/documents.spec.ts, ui/e2e/opensearch.spec.ts, ui/e2e/graph.spec.ts), on Linux
# runners only: Windows runners
# have no Linux containers, so there those specs are skipped and the Windows checklist covers
# them. Containers rather than job services, since services would also start on Windows.
#
#   e2e-services.sh start   pulls and starts the containers in the background (early in the job,
#                           so they are up by the time the build is done)
#   e2e-services.sh ready   waits for all of them, seeds MongoDB with
#                           ui/e2e/fixtures/mongo-orders.js and Neo4j and Memgraph with ui/e2e/fixtures/graph-shop.cypher, and
#                           writes KALZIT_E2E_MONGODB, KALZIT_E2E_OPENSEARCH, KALZIT_E2E_NEO4J and
#                           KALZIT_E2E_MEMGRAPH to $GITHUB_ENV
#
# The images are those of the server tests' services in ci.yml. The passwords belong to throwaway
# containers reachable only from this job; they protect nothing and are not secrets. Kalzit reads
# MongoDB with the fixture's read-only login. Neo4j Community and Memgraph Community have no
# read-only users (roles and privileges need the enterprise editions): Neo4j enforces the read
# transaction Kalzit runs every query in, and the Memgraph source is set to accept a user who may
# write (`allowWriteCapableUser`), as the server tests do.
set -euo pipefail

MONGO=kalzit-e2e-mongo
OPENSEARCH=kalzit-e2e-opensearch
NEO4J=kalzit-e2e-neo4j
MEMGRAPH=kalzit-e2e-memgraph
ROOT_PASSWORD=kalzit-e2e-root
# Also in GRAPH_FIXTURE (ui/e2e/support/services.ts).
NEO4J_PASSWORD=kalzit-e2e-neo4j
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURE="$HERE/../../ui/e2e/fixtures/mongo-orders.js"
GRAPH_FIXTURE="$HERE/../../ui/e2e/fixtures/graph-shop.cypher"

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
  docker run -d --name "$NEO4J" -p 127.0.0.1:7687:7687 \
    -e NEO4J_AUTH="neo4j/$NEO4J_PASSWORD" \
    -e NEO4J_server_memory_heap_initial__size=256m -e NEO4J_server_memory_heap_max__size=512m \
    -e NEO4J_server_memory_pagecache_size=128m \
    neo4j:2026.10.0-community > /dev/null
  # Memgraph's limit is in MiB; the fixture needs a few.
  docker run -d --name "$MEMGRAPH" -p 127.0.0.1:7688:7687 \
    memgraph/memgraph:3.14.0 --memory-limit=512 > /dev/null
  echo "started $MONGO, $OPENSEARCH, $NEO4J and $MEMGRAPH"
}

cypher_neo4j() {
  docker exec -i "$NEO4J" cypher-shell -u neo4j -p "$NEO4J_PASSWORD" "$@"
}

cypher_memgraph() {
  docker exec -i "$MEMGRAPH" mgconsole "$@"
}

mongosh_root() {
  docker exec -i "$MONGO" mongosh --quiet -u root -p "$ROOT_PASSWORD" --authenticationDatabase admin "$@"
}

# Runs `$2` (a function reading the fixture from stdin) with the fixture file `$3`, a few times.
# The MongoDB image first runs a temporary server for its init scripts and restarts afterwards, so
# a ping can reach that one and the seed meet the restart; Neo4j and Memgraph may answer a first
# query before they take writes. A few tries with a pause ride over it; each fixture starts by
# deleting what an earlier try left.
seed() {
  local name="$1" run="$2" file="$3"
  for attempt in 1 2 3 4 5; do
    # Comment lines out, as mgconsole reads the file statement by statement.
    if grep -v '^//' "$file" | "$run"; then
      return 0
    fi
    echo "seeding $name failed (attempt $attempt of 5), trying again" >&2
    sleep 3
  done
  echo "seeding $name failed" >&2
  return 1
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
    if [ "${neo4j:-}" != ok ] && echo 'RETURN 1;' | cypher_neo4j > /dev/null 2>&1; then
      neo4j=ok
    fi
    if [ "${memgraph:-}" != ok ] && echo 'RETURN 1;' | cypher_memgraph > /dev/null 2>&1; then
      memgraph=ok
    fi
    if [ "${mongo:-}" = ok ] && [ "${os:-}" = ok ] \
      && [ "${neo4j:-}" = ok ] && [ "${memgraph:-}" = ok ]; then
      seed MongoDB mongosh_root "$FIXTURE"
      seed Neo4j cypher_neo4j "$GRAPH_FIXTURE"
      seed Memgraph cypher_memgraph "$GRAPH_FIXTURE"
      {
        echo "KALZIT_E2E_MONGODB=127.0.0.1:27017"
        echo "KALZIT_E2E_OPENSEARCH=http://127.0.0.1:9201"
        echo "KALZIT_E2E_NEO4J=127.0.0.1:7687"
        echo "KALZIT_E2E_MEMGRAPH=127.0.0.1:7688"
      } >> "$GITHUB_ENV"
      echo "MongoDB, OpenSearch, Neo4j and Memgraph are ready"
      return 0
    fi
    sleep 2
  done
  echo "MongoDB (${mongo:-not ready}), OpenSearch (${os:-not ready}), Neo4j (${neo4j:-not ready})" \
    "or Memgraph (${memgraph:-not ready}) did not become ready" >&2
  for container in "$MONGO" "$OPENSEARCH" "$NEO4J" "$MEMGRAPH"; do
    docker logs --tail 50 "$container" >&2 || true
  done
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
