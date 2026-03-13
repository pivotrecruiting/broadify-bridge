#!/usr/bin/env bash
# Sign the display-helper binary and bundled macOS SDL2 runtime.
# Uses a Developer ID identity when configured; otherwise falls back to ad-hoc
# signing so local dev builds remain loadable after install_name_tool rewrites.

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  exit 0
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BINARY="${1:-$ROOT_DIR/apps/bridge/native/display-helper/display-helper}"
RUNTIME="${2:-$(dirname "$BINARY")/libSDL2-2.0.0.dylib}"

IDENTITY="${APPLE_SIGNING_IDENTITY:-${CSC_NAME:-}}"
SIGN_LABEL="$IDENTITY"
if [[ -z "$IDENTITY" ]]; then
  IDENTITY="-"
  SIGN_LABEL="adhoc"
fi

targets=()
if [[ -f "$RUNTIME" ]]; then
  targets+=("$RUNTIME")
fi
if [[ -f "$BINARY" ]]; then
  targets+=("$BINARY")
fi

if [[ ${#targets[@]} -eq 0 ]]; then
  echo "Display helper artifacts not found at $BINARY / $RUNTIME" >&2
  exit 0
fi

echo "Signing display-helper artifacts with identity: $SIGN_LABEL"
for target in "${targets[@]}"; do
  codesign --force --sign "$IDENTITY" "$target"
  echo "Signed: $target"
done
