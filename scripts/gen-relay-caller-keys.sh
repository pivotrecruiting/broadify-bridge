#!/usr/bin/env bash
# Generate Ed25519 keypair for WebApp -> Relay caller assertion (Caller Auth).
# Output: PEM files + one-line values for RELAY_CALLER_SIGNING_PRIVATE_KEY and RELAY_CALLER_ASSERTION_PUBLIC_KEY.
# Do not commit the generated keys; .relay-caller-keys/ is gitignored.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="${SCRIPT_DIR}/.relay-caller-keys"
PRIVATE_PEM="${OUT_DIR}/relay-caller-webapp-private.pem"
PUBLIC_PEM="${OUT_DIR}/relay-caller-webapp-public.pem"

mkdir -p "$OUT_DIR"

if [[ -f "$PRIVATE_PEM" ]]; then
  echo "Existing key found at $PRIVATE_PEM. Delete it to regenerate." >&2
  read -r -p "Overwrite? [y/N] " ans
  if [[ "${ans:-n}" != "y" && "${ans:-n}" != "Y" ]]; then
    echo "Aborted."
    exit 0
  fi
fi

echo "Generating Ed25519 keypair..."
openssl genpkey -algorithm Ed25519 -out "$PRIVATE_PEM"
openssl pkey -in "$PRIVATE_PEM" -pubout -out "$PUBLIC_PEM"

# One-line PEM for env vars (backslash-n so it can be stored in one line)
to_one_line() {
  awk 'NF {sub(/\r/, ""); printf "%s\\n", $0;}' "$1"
}

PRIVATE_ONE_LINE=$(to_one_line "$PRIVATE_PEM")
PUBLIC_ONE_LINE=$(to_one_line "$PUBLIC_PEM")

echo ""
echo "--- PEM files (do not commit) ---"
echo "  Private: $PRIVATE_PEM"
echo "  Public:  $PUBLIC_PEM"
echo ""
echo "--- For WebApp (Vercel): RELAY_CALLER_SIGNING_PRIVATE_KEY ---"
echo "$PRIVATE_ONE_LINE"
echo ""
echo "--- For Relay (Fly): RELAY_CALLER_ASSERTION_PUBLIC_KEY ---"
echo "$PUBLIC_ONE_LINE"
echo ""
echo "Optional: RELAY_CALLER_SIGNING_KID=webapp-1, RELAY_CALLER_ASSERTION_KID=webapp-1, RELAY_CALLER_ASSERTION_TTL_SECONDS=30"
echo "See docs/security/relay-caller-auth-setup.md for deployment steps."
