#!/usr/bin/env bash
# Sign the display-helper binary for macOS release/notarization.
# Requires: APPLE_SIGNING_IDENTITY or CSC_NAME (Developer ID Application: <Team>)
# No-op when identity is not set (local dev builds).

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  exit 0
fi

BINARY="${1:-}"
if [[ -z "$BINARY" ]]; then
  ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  BINARY="$ROOT_DIR/apps/bridge/native/display-helper/display-helper"
fi

if [[ ! -f "$BINARY" ]]; then
  echo "Display helper binary not found at $BINARY" >&2
  exit 0
fi

IDENTITY="${APPLE_SIGNING_IDENTITY:-${CSC_NAME:-}}"
if [[ -z "$IDENTITY" ]]; then
  echo "Skipping display-helper signing (no APPLE_SIGNING_IDENTITY/CSC_NAME)."
  exit 0
fi

echo "Signing display-helper with identity: $IDENTITY"
codesign --force --sign "$IDENTITY" "$BINARY"
echo "Signed: $BINARY"
