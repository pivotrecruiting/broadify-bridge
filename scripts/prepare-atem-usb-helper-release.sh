#!/usr/bin/env bash
set -euo pipefail

# Builds the ATEM USB helper locally (macOS; ATEM SDK required) and prints the
# upload artifacts + SHA256 for the release secrets. The Windows .exe is built
# on a Windows machine via build.ps1; hash it there with:
#   Get-FileHash atem-usb-helper.exe -Algorithm SHA256
# See apps/bridge/native/atem-usb-helper/DEPLOY.md for the full flow.

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Run this on macOS; the Windows artifact is prepared via build.ps1." >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HELPER_DIR="$ROOT_DIR/apps/bridge/native/atem-usb-helper"
# ATEM_HELPER_ARCH=x86_64 cross-builds the x64 asset on Apple Silicon.
arch="${ATEM_HELPER_ARCH:-$(uname -m)}"
case "$arch" in
  arm64) asset_arch="arm64" ;;
  x86_64) asset_arch="x64" ;;
  *)
    echo "Unsupported macOS architecture: ${arch}" >&2
    exit 1
    ;;
esac

bash "$HELPER_DIR/build.sh"

artifact="$HELPER_DIR/atem-usb-helper-${asset_arch}"
cp "$HELPER_DIR/atem-usb-helper" "$artifact"

echo "Artifact: $artifact"
echo "SHA256:   $(shasum -a 256 "$artifact" | awk '{print $1}')"
echo "Upload the artifact as a release asset and set ATEM_USB_HELPER_URL_/SHA256_ secrets."
