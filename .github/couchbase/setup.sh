#!/usr/bin/env bash
# Prepares the Couchbase container named "couchbase" (couchbase/server community, ports 8091 and
# 8093) for server/tests/couchbase.rs: a one-node cluster with the data, query and index services,
# the bucket "kalzit" with a primary index and three documents, and, where the edition offers the
# roles, the reader "leser" with only query_select and data_reader. Used by the CI job
# datasources-more; run on a fresh container only.
#
# The passwords belong to a throwaway container reachable only from the job; they protect nothing.
#   Administrator / kalzit-ci-couchbase   the cluster administrator
#   leser / kalzit-ci-leser               the reader (when the roles exist)
#
# Writes "leser:kalzit-ci-leser" to $1 when the reader was created, else an empty file.
set -euo pipefail

reader_file=$1
admin=Administrator:kalzit-ci-couchbase
base=http://127.0.0.1:8091

for i in $(seq 1 120); do
  if curl -fs "$base/ui/index.html" > /dev/null; then break; fi
  if [ "$i" = 120 ]; then echo "Couchbase did not start" >&2; docker logs --tail 50 couchbase >&2; exit 1; fi
  sleep 2
done

curl -fsS -X POST "$base/node/controller/setupServices" -d services=kv%2Cn1ql%2Cindex > /dev/null
curl -fsS -X POST "$base/pools/default" -d memoryQuota=512 -d indexMemoryQuota=256 > /dev/null
curl -fsS -X POST "$base/settings/web" -d port=8091 -d username=Administrator -d password=kalzit-ci-couchbase > /dev/null
# Community Edition keeps index data in ForestDB.
curl -fsS -u "$admin" -X POST "$base/settings/indexes" -d storageMode=forestdb > /dev/null
curl -fsS -u "$admin" -X POST "$base/pools/default/buckets" \
  -d name=kalzit -d ramQuota=128 -d bucketType=couchbase -d flushEnabled=0 > /dev/null

query() {
  curl -fsS -u "$admin" http://127.0.0.1:8093/query/service --data-urlencode "statement=$1"
}

for i in $(seq 1 90); do
  if query "CREATE PRIMARY INDEX ON kalzit" > /dev/null 2>&1; then break; fi
  if [ "$i" = 90 ]; then echo "the query service did not take the index" >&2; query "SELECT 1" >&2 || true; exit 1; fi
  sleep 2
done
for i in $(seq 1 60); do
  state=$(query "SELECT RAW state FROM system:indexes WHERE keyspace_id = 'kalzit' AND is_primary" || true)
  case "$state" in *online*) break;; esac
  if [ "$i" = 60 ]; then echo "the primary index did not come online: $state" >&2; exit 1; fi
  sleep 2
done

query "INSERT INTO kalzit (KEY, VALUE) VALUES ('ada', {'name': 'Ada', 'land': 'Österreich'}), ('bo', {'name': 'Bo', 'land': 'Schweiz'}), ('cy', {'name': 'Cy', 'land': 'Österreich'})" > /dev/null

if curl -fsS -u "$admin" -X PUT "$base/settings/rbac/users/local/leser" \
     -d password=kalzit-ci-leser -d 'roles=query_select[kalzit],data_reader[kalzit]' > /dev/null 2>&1; then
  echo "leser:kalzit-ci-leser" > "$reader_file"
  echo "created the reader leser"
else
  : > "$reader_file"
  echo "this edition has no reading roles; the reader test is skipped"
fi
