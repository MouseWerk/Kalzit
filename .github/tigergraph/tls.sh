#!/usr/bin/env bash
# Switches the TigerGraph container's Nginx (port 14240) to HTTPS with a certificate from a fresh
# test CA, and writes the CA certificate to $1 for the TLS test in server/tests/tigergraph_real.rs.
# Runs after the HTTP tests: from then on the server answers only HTTPS.
set -euo pipefail

ca_out=$1
work=$(mktemp -d)
cd "$work"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=Kalzit nightly test CA" \
  -keyout ca.key -out ca.pem 2> /dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=localhost" -keyout server.key -out server.csr 2> /dev/null
printf 'subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\n' > ext.cnf
openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 2 \
  -extfile ext.cnf -out server.pem 2> /dev/null
cp ca.pem "$ca_out"

docker cp server.pem tigergraph:/tmp/kalzit-server.pem
docker cp server.key tigergraph:/tmp/kalzit-server.key
docker exec -u 0 tigergraph chmod 644 /tmp/kalzit-server.pem /tmp/kalzit-server.key
docker exec tigergraph bash -lc "export PATH=\$PATH:/home/tigergraph/tigergraph/app/cmd
  gadmin config set Nginx.SSL.Enable true
  gadmin config set Nginx.SSL.Cert @/tmp/kalzit-server.pem
  gadmin config set Nginx.SSL.Key @/tmp/kalzit-server.key
  gadmin config apply -y
  gadmin restart nginx -y"

for i in $(seq 1 60); do
  if curl -fs --cacert "$ca_out" -u tigergraph:tigergraph https://localhost:14240/gsql/v1/schema/graphs > /dev/null; then
    echo "HTTPS is up"
    exit 0
  fi
  sleep 2
done
echo "HTTPS did not come up" >&2
curl -sv --cacert "$ca_out" https://localhost:14240/ 2>&1 | tail -20 >&2 || true
exit 1
