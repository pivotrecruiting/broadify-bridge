#!/usr/bin/env bash
set -euo pipefail

# Downloads the prebuilt ATEM USB helper release asset (CI path; runners have
# no ATEM SDK). Locally the helper is built from source instead: when no URL
# is configured and a freshly built binary exists, this script is a no-op.
# Mirrors download-decklink-helper.sh, extended for the Windows target.

if [[ "${SKIP_ATEM_USB_HELPER_DOWNLOAD:-}" == "1" ]]; then
  echo "Skipping ATEM USB helper download (SKIP_ATEM_USB_HELPER_DOWNLOAD=1)."
  exit 0
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="$ROOT_DIR/apps/bridge/native/atem-usb-helper"

UNAME_S="$(uname -s)"
if [[ "$UNAME_S" == "Darwin" ]]; then
  target_name="atem-usb-helper"
  arch="$(uname -m)"
  case "$arch" in
    arm64)
      url="${ATEM_USB_HELPER_URL_ARM64:-}"
      sha256="${ATEM_USB_HELPER_SHA256_ARM64:-}"
      ;;
    x86_64)
      url="${ATEM_USB_HELPER_URL_X64:-}"
      sha256="${ATEM_USB_HELPER_SHA256_X64:-}"
      ;;
    *)
      echo "Unsupported macOS architecture: ${arch}" >&2
      exit 1
      ;;
  esac
elif [[ "$UNAME_S" == MINGW* || "$UNAME_S" == MSYS* || "$UNAME_S" == CYGWIN* ]]; then
  target_name="atem-usb-helper.exe"
  url="${ATEM_USB_HELPER_URL_WIN:-}"
  sha256="${ATEM_USB_HELPER_SHA256_WIN:-}"
else
  echo "Skipping ATEM USB helper download on unsupported platform."
  exit 0
fi

TARGET="$TARGET_DIR/$target_name"

if [[ -z "$url" || -z "$sha256" ]]; then
  if [[ -f "$TARGET" ]]; then
    echo "No ATEM USB helper download configured; using locally built $target_name."
    exit 0
  fi
  echo "ATEM USB helper download URL or SHA256 is missing and no local build exists." >&2
  echo "Build it locally (ATEM SDK required) or set ATEM_USB_HELPER_URL_*/SHA256_*." >&2
  exit 1
fi

mkdir -p "$TARGET_DIR"
tmpfile="$(mktemp)"

echo "Downloading ATEM USB helper (${target_name}) from: $url"
curl -fsSL "$url" -o "$tmpfile"

# Windows CI's Git Bash ships sha256sum but not shasum (same pattern as
# download-modnet-model.sh).
if command -v sha256sum >/dev/null 2>&1; then
  download_hash="$(sha256sum "$tmpfile" | awk '{print $1}')"
else
  download_hash="$(shasum -a 256 "$tmpfile" | awk '{print $1}')"
fi
if [[ "$download_hash" != "$sha256" ]]; then
  echo "ATEM USB helper SHA256 mismatch." >&2
  echo "Expected: $sha256" >&2
  echo "Actual:   $download_hash" >&2
  exit 1
fi

mv "$tmpfile" "$TARGET"
chmod +x "$TARGET"
echo "Downloaded ATEM USB helper to $TARGET"
