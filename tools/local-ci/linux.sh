#!/usr/bin/env bash
# The Linux leg of the local CI, run by run.sh inside WSL (Ubuntu) as the user `ci`, with sudo
# where ci.yml's runner uses it (Kalzit refuses to run plugins as root), in a checkout of the
# commit under test. It mirrors the Linux jobs of .github/workflows/ci.yml; a change there belongs
# here too. Not covered: `packages (arm64)` (no arm64 machine; release.yml still builds it).
#
# Environment: LOGS, AREAS, SRC (see common.sh), CARGO_TARGET_DIR, KALZIT_CI_CACHE (downloads
# and tools kept between runs), KALZIT_CI_LOCK, KALZIT_CI_STAGE, KALZIT_CI_ONLY (optional, see
# common.sh).

LEG=linux
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
. "$HOME/.cargo/env"
: "${CARGO_TARGET_DIR:?}" "${KALZIT_CI_CACHE:?}"
T=$CARGO_TARGET_DIR
PLATFORM=linux-x64
EXE=""
mkdir -p "$KALZIT_CI_CACHE"
export PLAYWRIGHT_BROWSERS_PATH="$KALZIT_CI_CACHE/playwright"
sccache_start

# A container by name, removed first so a run that died leaves nothing in the way.
container() {
  local name=$1
  shift
  docker rm -f "$name" > /dev/null 2>&1 || true
  docker run -d --name "$name" "$@" > /dev/null
}
remove_containers() { docker rm -f "$@" > /dev/null 2>&1 || true; }

wait_for() {
  local what=$1 tries=$2
  shift 2
  for _ in $(seq 1 "$tries"); do
    if "$@" > /dev/null 2>&1; then return 0; fi
    sleep 2
  done
  echo "$what did not become ready" >&2
  return 1
}

changes_test() { .github/scripts/changes.test.sh; }

postgres() {
  cargo test --locked --no-run --test api --test access --test analyses --test dashboard_features \
    --test settings_dashboards --test shell --test explore_history --test team_spaces --test cluster \
    --test two_factor --test sso --test mail_invitations --test service_accounts --test db_copy \
    --test app_plugins --test access_backups
  services_lock
  trap 'remove_containers kalzit-ci-postgres; services_unlock' EXIT
  container kalzit-ci-postgres -p 127.0.0.1:5432:5432 -e POSTGRES_USER=kalzit -e POSTGRES_DB=kalzit \
    -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17
  wait_for PostgreSQL 60 docker exec kalzit-ci-postgres pg_isready -U kalzit
  export KALZIT_TEST_POSTGRES_URL=postgres://kalzit@localhost:5432/kalzit KALZIT_TEST_REQUIRE_POSTGRES=1
  cargo test --locked --test api --test access --test analyses --test dashboard_features \
    --test settings_dashboards --test shell --test explore_history --test team_spaces --test cluster \
    --test two_factor postgres -- --nocapture
  cargo test --locked --test sso --test mail_invitations --test service_accounts --test db_copy \
    --test app_plugins --test access_backups -- --nocapture
}

ldap() {
  cargo build --locked --tests
  services_lock
  trap 'remove_containers kalzit-ci-ldap; services_unlock' EXIT
  container kalzit-ci-ldap -p 127.0.0.1:3389:389 -e LDAP_ORGANISATION=Kalzit -e LDAP_DOMAIN=kalzit.test \
    -e LDAP_ADMIN_PASSWORD=kalzit-ci-ldap -e LDAP_TLS=false osixia/openldap:1.5.0
  wait_for OpenLDAP 60 docker exec kalzit-ci-ldap ldapsearch -x -H ldap://localhost -b dc=kalzit,dc=test \
    -D cn=admin,dc=kalzit,dc=test -w kalzit-ci-ldap -s base "(objectClass=*)"
  KALZIT_TEST_REQUIRE_LDAP=1 KALZIT_TEST_LDAP_URL=ldap://127.0.0.1:3389 KALZIT_TEST_LDAP_BASE=dc=kalzit,dc=test \
    KALZIT_TEST_LDAP_ADMIN_DN=cn=admin,dc=kalzit,dc=test KALZIT_TEST_LDAP_ADMIN_PASSWORD=kalzit-ci-ldap \
    cargo test --locked --test ldap -- --nocapture
}

# Without `-p kalzit` (ci.yml has it): the whole workspace's features, as the server job builds
# them, so the test binary comes from that build instead of a second one (about 3 minutes).
update_rights() {
  cargo test --locked --test update_rights --no-run
  local binary
  binary="$(cargo test --locked --test update_rights --no-run --message-format=json \
    | jq -r 'select(.reason == "compiler-artifact" and .target.name == "update_rights" and .profile.test
        and .executable != null) | .executable' | head -1)"
  test -x "$binary"
  id kalzit > /dev/null 2>&1 || sudo useradd --system --no-create-home --shell /usr/sbin/nologin kalzit
  sudo rm -rf /var/lib/kalzit-rights-test
  sudo install -d -o kalzit -g kalzit -m 0700 /var/lib/kalzit-rights-test
  sudo env KALZIT_TEST_RIGHTS_DIR=/var/lib/kalzit-rights-test "$binary" --ignored --test-threads=1 --nocapture
  sudo rm -rf /var/lib/kalzit-rights-test
}

DATASOURCE_CONTAINERS=(kalzit-ci-ds-postgres kalzit-ci-ds-mysql kalzit-ci-ds-mariadb kalzit-ci-ds-mssql
  kalzit-ci-ds-prometheus kalzit-ci-ds-elasticsearch kalzit-ci-ds-opensearch kalzit-ci-ds-neo4j
  kalzit-ci-ds-memgraph kalzit-ci-ds-clickhouse kalzit-ci-ds-influxdb2 kalzit-ci-ds-influxdb3
  kalzit-ci-ds-loki kalzit-ci-ds-mongodb kalzit-ci-ds-tempo kalzit-ci-ds-jaeger kalzit-ci-ds-jaeger2)

datasources() {
  cargo build --locked --tests
  services_lock
  trap 'remove_containers "${DATASOURCE_CONTAINERS[@]}"; services_unlock' EXIT
  local p=127.0.0.1
  container kalzit-ci-ds-postgres -p $p:5432:5432 -e POSTGRES_USER=kalzit -e POSTGRES_PASSWORD=kalzit-ci-pg \
    -e POSTGRES_DB=kalzit postgres:17
  container kalzit-ci-ds-mysql -p $p:3306:3306 -e MYSQL_ROOT_PASSWORD=kalzit-ci-mysql -e MYSQL_DATABASE=kalzit mysql:8.4
  container kalzit-ci-ds-mariadb -p $p:3307:3306 -e MARIADB_ROOT_PASSWORD=kalzit-ci-mariadb \
    -e MARIADB_DATABASE=kalzit mariadb:11.4
  container kalzit-ci-ds-mssql -p $p:1433:1433 -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD=Kalzit-CI-mssql-1 \
    -e MSSQL_MEMORY_LIMIT_MB=2048 mcr.microsoft.com/mssql/server:2022-latest
  container kalzit-ci-ds-prometheus -p $p:9090:9090 prom/prometheus:v3.5.0
  container kalzit-ci-ds-elasticsearch -p $p:9200:9200 -e discovery.type=single-node \
    -e xpack.security.enabled=true -e xpack.security.http.ssl.enabled=false -e ELASTIC_PASSWORD=kalzit-ci-es \
    -e cluster.routing.allocation.disk.threshold_enabled=false -e "ES_JAVA_OPTS=-Xms512m -Xmx512m" \
    docker.elastic.co/elasticsearch/elasticsearch:9.5.5
  container kalzit-ci-ds-opensearch -p $p:9201:9200 -e discovery.type=single-node -e DISABLE_SECURITY_PLUGIN=true \
    -e DISABLE_INSTALL_DEMO_CONFIG=true -e cluster.routing.allocation.disk.threshold_enabled=false \
    -e "OPENSEARCH_JAVA_OPTS=-Xms512m -Xmx512m" opensearchproject/opensearch:3.9.0
  container kalzit-ci-ds-neo4j -p $p:7687:7687 -e NEO4J_AUTH=neo4j/kalzit-ci-neo4j \
    -e NEO4J_server_memory_heap_initial__size=256m -e NEO4J_server_memory_heap_max__size=512m \
    -e NEO4J_server_memory_pagecache_size=128m neo4j:2026.10.0-community
  container kalzit-ci-ds-memgraph -p $p:7688:7687 memgraph/memgraph:3.14.0
  container kalzit-ci-ds-clickhouse --memory 2g -p $p:8123:8123 -e CLICKHOUSE_USER=kalzit -e CLICKHOUSE_PASSWORD=kalzit-ci-clickhouse \
    -e CLICKHOUSE_DB=kalzit -e CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1 clickhouse/clickhouse-server:25.8
  container kalzit-ci-ds-influxdb2 -p $p:8086:8086 -e DOCKER_INFLUXDB_INIT_MODE=setup \
    -e DOCKER_INFLUXDB_INIT_USERNAME=kalzit -e DOCKER_INFLUXDB_INIT_PASSWORD=kalzit-ci-influx \
    -e DOCKER_INFLUXDB_INIT_ORG=kalzit -e DOCKER_INFLUXDB_INIT_BUCKET=kalzit \
    -e DOCKER_INFLUXDB_INIT_ADMIN_TOKEN=kalzit-ci-influx-token influxdb:2.7
  container kalzit-ci-ds-influxdb3 -p $p:8181:8181 influxdb:3-core \
    influxdb3 serve --node-id ci --object-store memory --without-auth
  container kalzit-ci-ds-loki -p $p:3100:3100 grafana/loki:3.5.0
  container kalzit-ci-ds-mongodb -p $p:27017:27017 -e MONGO_INITDB_ROOT_USERNAME=kalzit \
    -e MONGO_INITDB_ROOT_PASSWORD=kalzit-ci-mongo mongo:8.2 --wiredTigerCacheSizeGB 0.5
  container kalzit-ci-ds-tempo -p $p:3200:3200 -p $p:4318:4318 \
    -v "$SRC/.github/tempo/tempo.yaml:/etc/tempo.yaml:ro" grafana/tempo:2.8.1 -config.file=/etc/tempo.yaml
  container kalzit-ci-ds-jaeger -p $p:16686:16686 -p $p:4319:4318 jaegertracing/all-in-one:1.70.0
  container kalzit-ci-ds-jaeger2 -p $p:16687:16686 -p $p:4320:4318 jaegertracing/jaeger:2.8.0

  local pending=""
  for _ in $(seq 1 300); do
    pending=""
    docker exec kalzit-ci-ds-postgres pg_isready -U kalzit > /dev/null 2>&1 || pending="$pending postgres"
    docker exec kalzit-ci-ds-mysql mysqladmin ping -h 127.0.0.1 -uroot -pkalzit-ci-mysql > /dev/null 2>&1 \
      || pending="$pending mysql"
    docker exec kalzit-ci-ds-mariadb healthcheck.sh --connect --innodb_initialized > /dev/null 2>&1 \
      || pending="$pending mariadb"
    docker exec kalzit-ci-ds-mssql /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P Kalzit-CI-mssql-1 \
      -Q "SELECT 1" > /dev/null 2>&1 || pending="$pending mssql"
    curl -fs http://$p:9090/-/ready > /dev/null || pending="$pending prometheus"
    curl -fs -u elastic:kalzit-ci-es "http://$p:9200/_cluster/health?wait_for_status=yellow&timeout=1s" > /dev/null \
      || pending="$pending elasticsearch"
    curl -fs "http://$p:9201/_cluster/health?wait_for_status=yellow&timeout=1s" > /dev/null || pending="$pending opensearch"
    docker exec kalzit-ci-ds-neo4j cypher-shell -u neo4j -p kalzit-ci-neo4j "RETURN 1" > /dev/null 2>&1 \
      || pending="$pending neo4j"
    timeout 1 bash -c "</dev/tcp/$p/7688" 2> /dev/null || pending="$pending memgraph"
    curl -fs http://$p:8123/ping > /dev/null || pending="$pending clickhouse"
    curl -fs http://$p:8086/health > /dev/null || pending="$pending influxdb2"
    curl -fs http://$p:8181/health > /dev/null || pending="$pending influxdb3"
    curl -fs http://$p:3100/ready > /dev/null || pending="$pending loki"
    docker exec kalzit-ci-ds-mongodb mongosh --quiet -u kalzit -p kalzit-ci-mongo \
      --eval 'db.runCommand({ ping: 1 }).ok' > /dev/null 2>&1 || pending="$pending mongodb"
    curl -fs http://$p:3200/ready > /dev/null || pending="$pending tempo"
    curl -fs http://$p:16686/api/services > /dev/null || pending="$pending jaeger"
    curl -fs http://$p:16687/api/services > /dev/null || pending="$pending jaeger2"
    [ -z "$pending" ] && break
    sleep 2
  done
  if [ -n "$pending" ]; then
    echo "Not ready:$pending" >&2
    return 1
  fi
  export KALZIT_TEST_REQUIRE_DATABASES=1
  export KALZIT_TEST_POSTGRES_URL=postgres://kalzit:kalzit-ci-pg@localhost:5432/kalzit
  export KALZIT_TEST_MYSQL_URL=mysql://root:kalzit-ci-mysql@127.0.0.1:3306/kalzit
  export KALZIT_TEST_MARIADB_URL=mysql://root:kalzit-ci-mariadb@127.0.0.1:3307/kalzit
  export KALZIT_TEST_MSSQL_URL=mssql://sa:Kalzit-CI-mssql-1@127.0.0.1:1433/master
  export KALZIT_TEST_PROMETHEUS_URL=http://127.0.0.1:9090
  export KALZIT_TEST_ELASTICSEARCH_URL=http://elastic:kalzit-ci-es@127.0.0.1:9200
  export KALZIT_TEST_OPENSEARCH_URL=http://127.0.0.1:9201
  export KALZIT_TEST_NEO4J_URL=bolt://neo4j:kalzit-ci-neo4j@127.0.0.1:7687
  export KALZIT_TEST_MEMGRAPH_URL=bolt://127.0.0.1:7688
  export KALZIT_TEST_MONGODB_URL='mongodb://kalzit:kalzit-ci-mongo@127.0.0.1:27017/?authSource=admin'
  export KALZIT_TEST_CLICKHOUSE_URL=http://kalzit:kalzit-ci-clickhouse@127.0.0.1:8123/kalzit
  export KALZIT_TEST_INFLUXDB2_URL=http://kalzit:kalzit-ci-influx-token@127.0.0.1:8086/kalzit
  export KALZIT_TEST_INFLUXDB3_URL=http://127.0.0.1:8181/kalzit
  export KALZIT_TEST_LOKI_URL=http://127.0.0.1:3100
  export KALZIT_TEST_TEMPO_URL=http://127.0.0.1:3200 KALZIT_TEST_TEMPO_OTLP_URL=http://127.0.0.1:4318
  export KALZIT_TEST_JAEGER_URL=http://127.0.0.1:16686 KALZIT_TEST_JAEGER_OTLP_URL=http://127.0.0.1:4319
  export KALZIT_TEST_JAEGER2_URL=http://127.0.0.1:16687 KALZIT_TEST_JAEGER2_OTLP_URL=http://127.0.0.1:4320
  cargo test --locked --test datasources -- --nocapture
  cargo test --locked --test mongodb -- --nocapture
}

SQL_KV_CONTAINERS=(kalzit-ci-kv-graphite kalzit-ci-kv-redis kalzit-ci-kv-oracle kalzit-ci-kv-clickhouse)

# Graphite, Redis, Oracle and ClickHouse's native protocol (ci.yml, job `datasources-sql-kv`).
datasources_sql_kv() {
  cargo build --locked --tests
  services_lock
  trap 'remove_containers "${SQL_KV_CONTAINERS[@]}"; services_unlock' EXIT
  local p=127.0.0.1
  container kalzit-ci-kv-graphite -p $p:8080:80 -p $p:2003:2003 graphiteapp/graphite-statsd:1.1.10-5
  container kalzit-ci-kv-redis -p $p:6379:6379 redis:8.2
  container kalzit-ci-kv-oracle -p $p:1521:1521 -e ORACLE_PASSWORD=kalzit-ci-oracle-sys -e APP_USER=kalzit \
    -e APP_USER_PASSWORD=kalzit-ci-oracle --health-cmd healthcheck.sh --health-interval 5s \
    --health-timeout 5s --health-retries 60 gvenzl/oracle-free:23-slim
  container kalzit-ci-kv-clickhouse -p $p:9000:9000 -p $p:8124:8123 -e CLICKHOUSE_USER=kalzit \
    -e CLICKHOUSE_PASSWORD=kalzit-ci-clickhouse -e CLICKHOUSE_DB=kalzit -e CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1 \
    clickhouse/clickhouse-server:25.8
  local pending=""
  for _ in $(seq 1 300); do
    pending=""
    curl -fs "http://$p:8080/metrics/find?query=*" > /dev/null || pending="$pending graphite"
    docker exec kalzit-ci-kv-redis redis-cli ping 2> /dev/null | grep -q PONG || pending="$pending redis"
    [ "$(docker inspect -f '{{.State.Health.Status}}' kalzit-ci-kv-oracle)" = healthy ] || pending="$pending oracle"
    curl -fs http://$p:8124/ping > /dev/null || pending="$pending clickhouse"
    [ -z "$pending" ] && break
    sleep 2
  done
  if [ -n "$pending" ]; then
    echo "Not ready:$pending" >&2
    return 1
  fi
  export KALZIT_TEST_REQUIRE_DATABASES=1 KALZIT_TEST_GRAPHITE_URL=http://127.0.0.1:8080 \
    KALZIT_TEST_GRAPHITE_CARBON=127.0.0.1:2003 KALZIT_TEST_REDIS_URL=redis://127.0.0.1:6379 KALZIT_TEST_REDIS_MODULES=1 \
    KALZIT_TEST_ORACLE_URL=oracle://kalzit:kalzit-ci-oracle@127.0.0.1:1521/FREEPDB1 \
    KALZIT_TEST_CLICKHOUSE_NATIVE_URL=clickhouse://kalzit:kalzit-ci-clickhouse@127.0.0.1:9000/kalzit
  cargo test --locked --test datasources_sql_kv -- --nocapture
  cargo test --locked --lib -- datasources::oracle datasources::clickhouse_native --nocapture
}

MORE_CONTAINERS=(kalzit-ci-more-arangodb kalzit-ci-more-gremlin kalzit-ci-more-couchbase)

# ArangoDB, Gremlin Server and Couchbase (ci.yml, job `datasources-more`).
datasources_more() {
  cargo build --locked --tests
  services_lock
  reader="$(mktemp)"
  trap "remove_containers ${MORE_CONTAINERS[*]}; services_unlock; rm -f '$reader'" EXIT
  local p=127.0.0.1
  container kalzit-ci-more-arangodb -p $p:8529:8529 -e ARANGO_ROOT_PASSWORD=kalzit-ci-arango arangodb/arangodb:3.12.4
  container kalzit-ci-more-gremlin -p $p:8182:8182 tinkerpop/gremlin-server:3.7.3 conf/gremlin-server-modern.yaml
  container kalzit-ci-more-couchbase -p $p:8091-8097:8091-8097 couchbase/server:community-7.6.2
  local arango="" gremlin=""
  for _ in $(seq 1 150); do
    curl -fs -u root:kalzit-ci-arango http://$p:8529/_api/version > /dev/null && arango=ok
    timeout 1 bash -c "</dev/tcp/$p/8182" 2> /dev/null && gremlin=ok
    [ "$arango" = ok ] && [ "$gremlin" = ok ] && break
    sleep 2
  done
  [ "$arango" = ok ] && [ "$gremlin" = ok ] || { echo "ArangoDB or Gremlin Server did not become ready" >&2; return 1; }
  bash .github/couchbase/setup.sh "$reader"
  export KALZIT_TEST_COUCHBASE_READER="$(cat "$reader")" KALZIT_TEST_REQUIRE_DATABASES=1 \
    KALZIT_TEST_ARANGODB_URL=http://root:kalzit-ci-arango@127.0.0.1:8529 \
    KALZIT_TEST_GREMLIN_URL=ws://127.0.0.1:8182/gremlin \
    KALZIT_TEST_COUCHBASE_URL=http://Administrator:kalzit-ci-couchbase@127.0.0.1:8093
  cargo test --locked --test arangodb -- --nocapture
  cargo test --locked --test gremlin -- --nocapture
  cargo test --locked --test couchbase -- --nocapture
}

roadmap() { node tools/roadmap/render-progress.mjs --check; }

# Writes scaffolds into the checkout, so it runs last.
devgen_proof() {
  ui_install
  (cd tools/devgen && npm ci --no-audit --no-fund)
  (cd tools/devgen && npm run proof -- --in-place)
}

# The gate installs Chromium only (the smoke set runs there), the full suite all three.
e2e() {
  e2e_build
  .github/scripts/browser-deps.test.sh
  local attempt browsers=(chromium firefox webkit)
  [ "$STAGE" = gate ] && browsers=(chromium)
  for attempt in 1 2 3; do
    (cd ui && npx playwright install --with-deps "${browsers[@]}") && break
    echo "installing the browsers failed (attempt $attempt of 3)" >&2
    [ "$attempt" -lt 3 ] || return 1
  done
  services_lock
  local env_file
  env_file="$(mktemp)"
  # Expanded now: the trap runs after this function returned, when its locals are gone.
  trap "remove_containers kalzit-e2e-mongo kalzit-e2e-opensearch kalzit-e2e-neo4j kalzit-e2e-memgraph; services_unlock; rm -f '$env_file'" EXIT
  remove_containers kalzit-e2e-mongo kalzit-e2e-opensearch kalzit-e2e-neo4j kalzit-e2e-memgraph
  .github/scripts/e2e-services.sh start
  GITHUB_ENV="$env_file" .github/scripts/e2e-services.sh ready
  load_env_file "$env_file"
  e2e_playwright "$T/e2e/kalzit" "$T/e2e/kalzit-test-plugin"
}

docker_image() {
  docker build --build-arg CARGO_PROFILE=e2e --build-arg "KALZIT_BUILD_COMMIT=$(git rev-parse --short=9 HEAD)" \
    -t kalzit:ci .
  services_lock
  trap 'services_unlock' EXIT
  .github/scripts/docker-smoke.sh kalzit:ci
}

packages() {
  e2e_build
  "$T/e2e/kalzit" --version
  local version archive cached
  version="$(grep -m1 '^version = ' server/Cargo.toml | cut -d'"' -f2)"
  archive=nfpm_2.47.0_Linux_x86_64.tar.gz
  cached="$KALZIT_CI_CACHE/nfpm/$archive"
  if [ ! -f "$cached" ]; then
    mkdir -p "$(dirname "$cached")"
    curl -fsSL --retry 5 --retry-all-errors --retry-delay 10 -o "$cached" \
      "https://github.com/goreleaser/nfpm/releases/download/v2.47.0/$archive"
  fi
  echo "0660ca602b2d2d2ae4781a06c692b3eeb9d437ffea05b831d76e41f4a3188783  $cached" | sha256sum -c -
  sudo tar -xzf "$cached" -C /usr/local/bin nfpm
  local dist
  dist="$(mktemp -d)/dist"
  [ "$(uname -m)" = x86_64 ]
  # The packaged server listens on port 3000, and WSL forwards its ports to Windows, where 3000
  # is the owner's demo. In this throwaway checkout (cleaned before every run) the package and
  # its smoke test use port 39300 instead; nothing else about the package changes.
  sed -i 's/0\.0\.0\.0:3000/0.0.0.0:39300/' deploy/linux/kalzit.toml
  sed -i 's#127\.0\.0\.1:3000/#127.0.0.1:39300/#g' .github/scripts/package-smoke.sh
  grep -q '0.0.0.0:39300' deploy/linux/kalzit.toml
  ! grep -q '127.0.0.1:3000' .github/scripts/package-smoke.sh
  deploy/linux/package.sh "$version" "$T/e2e/kalzit" "$dist"
  [ "$(dpkg-deb -f "$dist/kalzit-$version-linux-x64.deb" Architecture)" = amd64 ]
  services_lock
  # Whatever the smoke test leaves behind when it fails partway: the package off this machine.
  trap 'sudo dpkg -P kalzit > /dev/null 2>&1 || true; services_unlock' EXIT
  .github/scripts/package-smoke.sh "$dist"
}

acme() {
  local pebble="$KALZIT_CI_CACHE/pebble-v2.10.1"
  if [ ! -x "$pebble/bin/pebble" ]; then
    rm -rf "$pebble"
    git clone --quiet --depth 1 --branch v2.10.1 https://github.com/letsencrypt/pebble.git "$pebble/src"
    (cd "$pebble/src" && go build -o "$pebble/bin/" ./cmd/pebble ./cmd/pebble-challtestsrv)
  fi
  # Without `-p kalzit`, as in update_rights: the server job's build.
  cargo test --locked --test acme_pebble --no-run
  grep -q 'http.kalzit.test' /etc/hosts     || echo "127.0.0.1 http.kalzit.test alpn.kalzit.test" | sudo tee -a /etc/hosts > /dev/null
  local logs
  logs="$(mktemp -d)"
  services_lock
  "$pebble/bin/pebble-challtestsrv" -defaultIPv4 127.0.0.1 -defaultIPv6 "" -http01 "" -https01 "" \
    -tlsalpn01 "" -doh "" -dnsserver ":8053" -management ":8055" > "$logs/challtestsrv.log" 2>&1 &
  local challtestsrv=$!
  (cd "$pebble/src" && PEBBLE_VA_NOSLEEP=1 PEBBLE_WFE_NONCEREJECT=0 PEBBLE_AUTHZREUSE=0 \
    exec "$pebble/bin/pebble" -config test/config/pebble-config.json -dnsserver 127.0.0.1:8053) \
    > "$logs/pebble.log" 2>&1 &
  local pebble_pid=$!
  # Expanded now: the trap runs after this function returned, when its locals are gone.
  trap "kill $challtestsrv $pebble_pid 2> /dev/null; services_unlock; cat '$logs'/*.log" EXIT
  wait_for pebble 30 curl -fsS --cacert "$pebble/src/test/certs/pebble.minica.pem" https://localhost:14000/dir
  KALZIT_TEST_PEBBLE_DIRECTORY=https://localhost:14000/dir \
    KALZIT_TEST_PEBBLE_CA="$pebble/src/test/certs/pebble.minica.pem" \
    cargo test --locked --test acme_pebble -- --ignored --nocapture
}

audit() {
  local db="$HOME/.cargo/advisory-db"
  local fetched=false
  for attempt in 1 2 3 4 5; do
    rm -rf "$db"
    if git clone --quiet --depth 1 https://github.com/RustSec/advisory-db.git "$db"; then
      fetched=true
      break
    fi
    echo "Fetching the advisory database failed (attempt $attempt of 5)" >&2
    sleep $((attempt * 10))
  done
  [ "$fetched" = true ]
  cargo fetch --locked
  local log status=0
  log="$(mktemp)"
  cargo audit --no-fetch 2>&1 | tee "$log" || status=$?
  if grep -q "couldn't check if the package is yanked" "$log"; then
    echo "cargo audit could not check every crate for a yanked release" >&2
    return 1
  fi
  [ "$status" -eq 0 ]
  node --test .github/scripts/npm-audit.test.mjs
  if [ -f ui/package-lock.json ]; then node .github/scripts/npm-audit.mjs ui; fi
}

# The UI checks (npm) run next to the server job (cargo); everything else one after another, the
# jobs with services under the services lock. The gate stops after the smoke e2e.
job changes always -- changes_test
job_bg ui ui -- ui
job server server -- server
wait_jobs
job sdk sdk -- sdk
job roadmap roadmap -- roadmap
job devkit devkit -- devkit
job devgen devgen server ui -- devgen
if [ "$STAGE" = gate ]; then
  job e2e e2e -- e2e
  for name in plugins audit update-rights postgres ldap datasources datasources-sql-kv datasources-more \
    acme packages docker devgen-proof; do
    skip_job "$name" "full suite"
  done
  finish
  exit
fi
job plugins server -- plugins
job audit audit -- audit
job update-rights server -- update_rights
job postgres server -- postgres
job ldap server -- ldap
job datasources server -- datasources
job datasources-sql-kv server -- datasources_sql_kv
job datasources-more server -- datasources_more
job acme server -- acme
job e2e e2e -- e2e
job packages docker -- packages
job docker docker -- docker_image
job devgen-proof devgen_proof -- devgen_proof
finish
