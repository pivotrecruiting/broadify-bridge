#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Skipping DeckLink helper prepare on non-macOS."
  exit 0
fi

if [[ "${USE_PREBUILT_DECKLINK_HELPER:-}" != "1" ]]; then
  echo "Skipping prebuilt DeckLink helper prepare."
  exit 0
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="$ROOT_DIR/apps/bridge/native/decklink-helper/decklink-helper"

arch="$(uname -m)"
case "$arch" in
  arm64) bin_arch="arm64" ;;
  x86_64) bin_arch="x64" ;;
  *)
    echo "Unsupported macOS architecture: ${arch}" >&2
    exit 1
    ;;
esac

SOURCE="$ROOT_DIR/apps/bridge/native/decklink-helper/bin/${bin_arch}/decklink-helper"

if [[ ! -f "$SOURCE" ]]; then
  echo "Prebuilt DeckLink helper not found at $SOURCE" >&2
  exit 1
fi

cp "$SOURCE" "$TARGET"
chmod +x "$TARGET"
echo "Prepared DeckLink helper from $SOURCE"
