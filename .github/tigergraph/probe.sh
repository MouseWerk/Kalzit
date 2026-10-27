#!/usr/bin/env bash
# Prints the raw answers of the endpoints Kalzit calls, as the reader user, so the nightly log
# shows what the real server does when a test fails or the fake needs updating. Never fails.
set -uo pipefail

base=http://127.0.0.1:14240
reader=kalzit_leser:leser-Passwort1

show() {
  echo
  echo "== $1"
  shift
  curl -sS -w '\n[HTTP %{http_code}]\n' "$@" | head -c 6000
}

show "version (no auth)" "$base/restpp/version"
show "schema of social" -u "$reader" "$base/gsql/v1/schema/graphs/social"
show "own user record" -u "$reader" "$base/gsql/v1/users/kalzit_leser"
show "SHOW USER" -u "$reader" -H 'Content-Type: text/plain' --data-binary 'SHOW USER' "$base/gsql/v1/statements"
show "query list" -u "$reader" "$base/gsql/v1/queries?graph=social"
show "query text nachbarn" -u "$reader" "$base/gsql/v1/queries/nachbarn?graph=social"
show "query info nachbarn" -u "$reader" "$base/gsql/v1/queries/info?graph=social&query=nachbarn"
show "token for the reader" -u "$reader" -H 'Content-Type: application/json' \
  -d '{"graph": "social", "lifetime": "3600"}' "$base/gsql/v1/tokens"
token=$(curl -sS -u "$reader" -H 'Content-Type: application/json' -d '{"graph": "social", "lifetime": "3600"}' \
  "$base/gsql/v1/tokens" | jq -r '.token // .results.token // empty')
show "installed nachbarn without a token" "$base/restpp/query/social/nachbarn?p=1"
show "installed nachbarn" -H "Authorization: Bearer $token" "$base/restpp/query/social/nachbarn?p=1&tiefe=2&tags=a+b&tags=c%26d"
show "installed zahlen" -H "Authorization: Bearer $token" \
  "$base/restpp/query/social/zahlen?k=3&name=Ana&ab=2024-01-01+00%3A00%3A00&liste=1&liste=2&v=1&v.type=Person"
show "installed loescht (refused, or Opfer is gone)" -H "Authorization: Bearer $token" "$base/restpp/query/social/loescht"
show "interpreted" -u "$reader" -H 'Content-Type: text/plain' \
  --data-binary 'INTERPRET QUERY (STRING name) FOR GRAPH social { S = {Person.*}; R = SELECT s FROM S:s WHERE s.name == name; PRINT R; }' \
  "$base/gsql/v1/queries/interpret?graph=social&name=Ana"
show "interpreted, edges" -u "$reader" -H 'Content-Type: text/plain' \
  --data-binary 'INTERPRET QUERY () FOR GRAPH social { SetAccum<EDGE> @@e; S = {Person.*}; R = SELECT t FROM S:s -(Friend|Lebt>:e)- :t ACCUM @@e += e; PRINT R; PRINT @@e; }' \
  "$base/gsql/v1/queries/interpret?graph=social"
show "interpreted delete as reader" -u "$reader" -H 'Content-Type: text/plain' \
  --data-binary 'INTERPRET QUERY () FOR GRAPH social { S = {Person.*}; DELETE s FROM S:s WHERE s.name == "niemand"; PRINT 1; }' \
  "$base/gsql/v1/queries/interpret?graph=social"
show "writer's own record" -u kalzit_schreiber:schreiber-Passwort1 "$base/gsql/v1/users/kalzit_schreiber"
show "superuser record" -u tigergraph:tigergraph "$base/gsql/v1/users/tigergraph"
show "SHOW USER as superuser" -u tigergraph:tigergraph -H 'Content-Type: text/plain' --data-binary 'SHOW USER' "$base/gsql/v1/statements"
exit 0
