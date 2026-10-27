#!/usr/bin/env bash
# Starts the services in the TigerGraph container named "tigergraph" (tigergraph/community, port
# 14240), then creates the test graph, data, queries and users for server/tests/tigergraph_real.rs.
# Used by .github/workflows/tigergraph-nightly.yml; run on a fresh container only.
#
# Users (passwords only for this throwaway instance):
#   tigergraph / tigergraph        the image's superuser, used only here to set things up
#   kalzit_leser / leser-Passwort1 queryreader on the graph social
#   kalzit_schreiber / schreiber-Passwort1 querywriter on the graph social
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
base=http://127.0.0.1:14240
admin=tigergraph:tigergraph

tg() {
  docker exec tigergraph bash -lc "export PATH=\$PATH:/home/tigergraph/tigergraph/app/cmd; $1"
}

echo "== gadmin start all"
for i in $(seq 1 3); do
  if tg "gadmin start all"; then break; fi
  echo "gadmin start all failed (attempt $i), retrying" >&2
  sleep 20
done

echo "== REST++ authentication on (the Community Edition starts without it)"
tg "gadmin config set RESTPP.Factory.EnableAuth true && gadmin config apply -y && gadmin restart restpp -y"

echo "== waiting for the GSQL server and REST++"
for i in $(seq 1 180); do
  if curl -fs -u "$admin" "$base/gsql/v1/schema/graphs" > /dev/null 2>&1 \
       && curl -fs "$base/restpp/echo" > /dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 5
done
if [ -z "${ready:-}" ]; then
  echo "TigerGraph did not become ready" >&2
  tg "gadmin status -v" || true
  exit 1
fi
tg "gadmin version" || true

gsql_file() {
  docker cp "$1" tigergraph:/tmp/kalzit.gsql
  tg "gsql /tmp/kalzit.gsql"
}

echo "== schema"
gsql_file "$here/schema.gsql"

echo "== data"
token=$(curl -fsS -u "$admin" -H 'Content-Type: application/json' \
  -d '{"graph": "social", "lifetime": "3600"}' "$base/gsql/v1/tokens" | jq -r '.token // .results.token')
echo "::add-mask::$token"
auth=$(mktemp)
printf 'Authorization: Bearer %s\n' "$token" > "$auth"
curl -fsS -H @"$auth" -H 'Content-Type: application/json' \
  -d @"$here/data.json" "$base/restpp/graph/social"
echo

echo "== queries (installing takes a few minutes)"
gsql_file "$here/queries.gsql"

echo "== users"
# Prints the answer; fails on an HTTP error or {"error": true}.
call() {
  local body code
  body=$(curl -sS -o - -w '\n%{http_code}' "$@")
  code=$(tail -n 1 <<< "$body")
  body=$(sed '$d' <<< "$body")
  echo "$body [HTTP $code]"
  [ "${code:0:1}" = 2 ] && ! grep -q '"error": *true' <<< "$body"
}
for u in kalzit_leser:leser-Passwort1:queryreader kalzit_schreiber:schreiber-Passwort1:querywriter; do
  IFS=: read -r name password role <<< "$u"
  user="{\"name\": \"$name\", \"password\": \"$password\"}"
  call -u "$admin" -H 'Content-Type: application/json' -d "$user" "$base/gsql/v1/users" \
    || call -u "$admin" -H 'Content-Type: application/json' -d "[$user]" "$base/gsql/v1/users" \
    || call -u "$admin" -H 'Content-Type: application/json' \
         -d "{\"username\": \"$name\", \"password\": \"$password\"}" "$base/gsql/v1/users" \
    || call -u "$admin" -H 'Content-Type: text/plain' \
         --data-binary "CREATE USER $name WITH PASSWORD \"$password\"" "$base/gsql/v1/statements"
  call -u "$admin" -H 'Content-Type: text/plain' \
    --data-binary "GRANT ROLE $role ON GRAPH social TO $name" "$base/gsql/v1/statements"
done
echo "== done"
