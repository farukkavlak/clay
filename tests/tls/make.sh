#!/bin/sh
# Writes the test certificates again. They stand for no real host and guard nothing.
set -eu
cd "$(dirname "$0")"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 36500 \
  -subj /CN=clay-test-ca -keyout "$work/ca.key" -out ca.pem

openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
  -subj /CN=localhost -keyout server.key -out "$work/server.csr"
printf 'subjectAltName=DNS:localhost,IP:127.0.0.1\n' > "$work/server.ext"
openssl x509 -req -days 36500 -in "$work/server.csr" -CA ca.pem -CAkey "$work/ca.key" \
  -CAcreateserial -CAserial "$work/ca.srl" -extfile "$work/server.ext" -out server.pem

openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
  -subj /CN=clay-test-client -keyout client.key -out "$work/client.csr"
printf 'extendedKeyUsage=clientAuth\n' > "$work/client.ext"
openssl x509 -req -days 36500 -in "$work/client.csr" -CA ca.pem -CAkey "$work/ca.key" \
  -CAserial "$work/ca.srl" -extfile "$work/client.ext" -out client.pem

openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
  -subj /CN=clay-test-intermediate -keyout "$work/intermediate.key" -out "$work/intermediate.csr"
printf 'basicConstraints=critical,CA:true\nkeyUsage=critical,keyCertSign\n' > "$work/intermediate.ext"
openssl x509 -req -days 36500 -in "$work/intermediate.csr" -CA ca.pem -CAkey "$work/ca.key" \
  -CAserial "$work/ca.srl" -extfile "$work/intermediate.ext" -out intermediate.pem

openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
  -subj /CN=localhost -keyout chained.key -out "$work/chained.csr"
openssl x509 -req -days 36500 -in "$work/chained.csr" -CA intermediate.pem -CAkey "$work/intermediate.key" \
  -CAcreateserial -CAserial "$work/intermediate.srl" -extfile "$work/server.ext" -out chained.pem

openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 36500 \
  -subj /CN=localhost -addext subjectAltName=DNS:localhost,IP:127.0.0.1 -keyout self.key -out self.pem
