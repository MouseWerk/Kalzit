#!/usr/bin/env bash
# Puts HTTPS in front of TigerGraph: an Nginx container on https://localhost:14243 with a
# certificate from a fresh test CA, forwarding to the TigerGraph container on port 14240. Writes
# the CA certificate to $1 for the TLS test in server/tests/tigergraph_real.rs.
#
# TigerGraph's own HTTPS (Nginx.SSL.Enable) needs an Enterprise license; the Community Edition
# refuses it ("Enterprise Edition license is required"), so a reverse proxy, as many installations
# have, terminates TLS here.
set -euo pipefail

ca_out=$1
# nginx:1.30.6-alpine, pinned by digest.
image=nginx@sha256:47928bf67eb62a1863cb08d9ecb52d3e704304ba614eaee17884204677702951
work=$(mktemp -d)
cd "$work"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=Kalzit nightly test CA" \
  -keyout ca.key -out ca.pem 2> /dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=localhost" -keyout server.key -out server.csr 2> /dev/null
printf 'subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\n' > ext.cnf
openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 2 \
  -extfile ext.cnf -out server.pem 2> /dev/null
cp ca.pem "$ca_out"
chmod 644 server.key
cat > tls.conf <<'EOF'
server {
  listen 14243 ssl;
  ssl_certificate /etc/nginx/certs/server.pem;
  ssl_certificate_key /etc/nginx/certs/server.key;
  client_max_body_size 16m;
  location / {
    proxy_pass http://127.0.0.1:14240;
    proxy_set_header Host $host;
    proxy_read_timeout 600s;
  }
}
EOF

docker run -d --name tigergraph-tls --network host \
  -v "$work/tls.conf:/etc/nginx/conf.d/default.conf:ro" \
  -v "$work/server.pem:/etc/nginx/certs/server.pem:ro" \
  -v "$work/server.key:/etc/nginx/certs/server.key:ro" \
  "$image" > /dev/null

for i in $(seq 1 30); do
  if curl -fs --cacert "$ca_out" -u tigergraph:tigergraph https://localhost:14243/gsql/v1/schema/graphs > /dev/null; then
    echo "HTTPS is up"
    exit 0
  fi
  sleep 2
done
echo "HTTPS did not come up" >&2
docker logs tigergraph-tls >&2 || true
exit 1
