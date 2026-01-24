#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Skipping DeckLink helper download on non-macOS."
  exit 0
fi

if [[ "${SKIP_DECKLINK_HELPER_DOWNLOAD:-}" == "1" ]]; then
  echo "Skipping DeckLink helper download (SKIP_DECKLINK_HELPER_DOWNLOAD=1)."
  exit 0
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="$ROOT_DIR/apps/bridge/native/decklink-helper"
TARGET="$TARGET_DIR/decklink-helper"

arch="$(uname -m)"
case "$arch" in
  arm64)
    url="${DECKLINK_HELPER_URL_ARM64:-}"
    sha256="${DECKLINK_HELPER_SHA256_ARM64:-}"
    ;;
  x86_64)
    url="${DECKLINK_HELPER_URL_X64:-}"
    sha256="${DECKLINK_HELPER_SHA256_X64:-}"
    ;;
  *)
    echo "Unsupported macOS architecture: ${arch}" >&2
    exit 1
    ;;
esac

if [[ -z "$url" || -z "$sha256" ]]; then
  echo "DeckLink helper download URL or SHA256 is missing for ${arch}." >&2
  exit 1
fi

mkdir -p "$TARGET_DIR"
tmpfile="$(mktemp)"

echo "Downloading DeckLink helper (${arch}) from: $url"
curl -fsSL "$url" -o "$tmpfile"

download_hash="$(shasum -a 256 "$tmpfile" | awk '{print $1}')"
if [[ "$download_hash" != "$sha256" ]]; then
  echo "DeckLink helper SHA256 mismatch for ${arch}." >&2
  echo "Expected: $sha256" >&2
  echo "Actual:   $download_hash" >&2
  exit 1
fi

mv "$tmpfile" "$TARGET"
chmod +x "$TARGET"
echo "Downloaded DeckLink helper to $TARGET"
