#!/usr/bin/env bash
# Turns REST++ authentication off again, as a fresh Community Edition has it, for the warning
# test in server/tests/tigergraph_real.rs, and waits until REST++ answers without a token.
set -euo pipefail

docker exec tigergraph bash -lc "export PATH=\$PATH:/home/tigergraph/tigergraph/app/cmd
  gadmin config set RESTPP.Factory.EnableAuth false
  gadmin config apply -y
  gadmin restart restpp -y"
for i in $(seq 1 60); do
  if curl -fs http://127.0.0.1:14240/restpp/version > /dev/null; then
    echo "REST++ answers without a token"
    exit 0
  fi
  sleep 2
done
echo "REST++ still refuses requests without a token" >&2
exit 1
