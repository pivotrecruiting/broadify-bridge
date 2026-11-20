#!/usr/bin/env bash
# Generate a throwaway "corporate" root CA plus a leaf certificate for the relay
# host, mimicking what a TLS-inspecting firewall presents to the bridge.
# The private keys stay in the out/ directory (gitignored). Never install this
# CA on a production machine; remove it after the test.
#
# Usage: make-ca.sh <relay-host> [out-dir]
set -euo pipefail

RELAY_HOST="${1:?usage: make-ca.sh <relay-host> [out-dir]}"
OUT_DIR="${2:-$(cd "$(dirname "$0")" && pwd)/out}"
CA_NAME="Broadify Test Inspection Root CA (DO NOT TRUST IN PRODUCTION)"
DAYS=30

mkdir -p "$OUT_DIR"

openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days "$DAYS" \
  -keyout "$OUT_DIR/fake-corp-root.key" -out "$OUT_DIR/fake-corp-root.pem" \
  -subj "/CN=$CA_NAME" >/dev/null 2>&1

openssl req -newkey rsa:2048 -sha256 -nodes \
  -keyout "$OUT_DIR/leaf.key" -out "$OUT_DIR/leaf.csr" \
  -subj "/CN=$RELAY_HOST" >/dev/null 2>&1

printf 'subjectAltName=DNS:%s\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n' \
  "$RELAY_HOST" > "$OUT_DIR/leaf.ext"

openssl x509 -req -sha256 -days "$DAYS" -in "$OUT_DIR/leaf.csr" \
  -CA "$OUT_DIR/fake-corp-root.pem" -CAkey "$OUT_DIR/fake-corp-root.key" -CAcreateserial \
  -out "$OUT_DIR/leaf.pem" -extfile "$OUT_DIR/leaf.ext" >/dev/null 2>&1

# The chain deliberately includes the self-signed root: that is what produces
# SELF_SIGNED_CERT_IN_CHAIN on the bridge, exactly like the customer's firewall.
cat "$OUT_DIR/leaf.pem" "$OUT_DIR/fake-corp-root.pem" > "$OUT_DIR/chain.pem"

# DER copy for the Windows certificate import (certutil / certmgr).
openssl x509 -in "$OUT_DIR/fake-corp-root.pem" -outform DER -out "$OUT_DIR/fake-corp-root.cer"

rm -f "$OUT_DIR/leaf.csr" "$OUT_DIR/leaf.ext"

echo "Root CA:      $OUT_DIR/fake-corp-root.pem  (Windows: fake-corp-root.cer)"
echo "Server chain: $OUT_DIR/chain.pem + leaf.key  (CN/SAN: $RELAY_HOST, valid $DAYS days)"
echo "CA subject:   $CA_NAME"
