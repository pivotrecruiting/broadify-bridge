#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "DeckLink helper release asset preparation requires macOS." >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HELPER_DIR="$ROOT_DIR/apps/bridge/native/decklink-helper"
HELPER_BIN="$HELPER_DIR/decklink-helper"

arch="$(uname -m)"
case "$arch" in
  arm64)
    artifact_arch="arm64"
    ;;
  x86_64)
    artifact_arch="x64"
    ;;
  *)
    echo "Unsupported macOS architecture: ${arch}" >&2
    exit 1
    ;;
esac

RELEASE_FILENAME="${DECKLINK_HELPER_RELEASE_FILENAME:-decklink-helper-${artifact_arch}}"
ARTIFACT_PATH="$HELPER_DIR/$RELEASE_FILENAME"

bash "$ROOT_DIR/scripts/build-decklink-helper.sh"

if [[ ! -x "$HELPER_BIN" ]]; then
  echo "Built DeckLink helper missing at $HELPER_BIN" >&2
  exit 1
fi

cp "$HELPER_BIN" "$ARTIFACT_PATH"
chmod +x "$ARTIFACT_PATH"

if command -v vtool >/dev/null 2>&1; then
  helper_minos="$(vtool -show-build "$ARTIFACT_PATH" 2>/dev/null | awk '/minos / { print $2; exit }')"
  if [[ -n "$helper_minos" ]]; then
    echo "DeckLink helper release asset minOS: $helper_minos"
  fi
fi

sha256="$(shasum -a 256 "$ARTIFACT_PATH" | awk '{print $1}')"

echo "Prepared release asset: $ARTIFACT_PATH"
echo "SHA256: $sha256"
