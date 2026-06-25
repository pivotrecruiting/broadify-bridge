#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[PresentationRuntime] macOS is required" >&2
  exit 1
fi

if [[ "$(uname -m)" != "arm64" ]]; then
  echo "[PresentationRuntime] Apple Silicon is required" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST_PATH="${ROOT_DIR}/apps/bridge/vendor/presentation-runtime/manifest.json"
VERSION="$(node -pe "JSON.parse(require('fs').readFileSync('${MANIFEST_PATH}','utf8')).libreoffice_version")"
FILENAME="$(node -pe "JSON.parse(require('fs').readFileSync('${MANIFEST_PATH}','utf8')).libreoffice_dmg.filename")"
URL="$(node -pe "JSON.parse(require('fs').readFileSync('${MANIFEST_PATH}','utf8')).libreoffice_dmg.url")"
SHA256="$(node -pe "JSON.parse(require('fs').readFileSync('${MANIFEST_PATH}','utf8')).libreoffice_dmg.sha256")"
CACHE_DIR="${BROADIFY_RUNTIME_CACHE_DIR:-${HOME}/Library/Caches/Broadify Bridge}"
DMG_PATH="${CACHE_DIR}/${FILENAME}"
RUNTIME_DIR="${ROOT_DIR}/apps/bridge/vendor/presentation-runtime/macos-arm64"
MOUNT_DIR="$(mktemp -d /tmp/broadify-libreoffice.XXXXXX)"

cleanup() {
  hdiutil detach "$MOUNT_DIR" -quiet >/dev/null 2>&1 || true
  rmdir "$MOUNT_DIR" >/dev/null 2>&1 || true
}
trap cleanup EXIT

mkdir -p "$CACHE_DIR"
if [[ ! -f "$DMG_PATH" ]]; then
  curl --fail --location --retry 3 --output "$DMG_PATH" "$URL"
fi

ACTUAL_SHA256="$(shasum -a 256 "$DMG_PATH" | awk '{print $1}')"
if [[ "$ACTUAL_SHA256" != "$SHA256" ]]; then
  rm -f "$DMG_PATH"
  echo "[PresentationRuntime] LibreOffice checksum mismatch" >&2
  exit 1
fi

hdiutil attach "$DMG_PATH" -nobrowse -readonly -mountpoint "$MOUNT_DIR" >/dev/null
SOURCE_APP="${MOUNT_DIR}/LibreOffice.app"
if [[ ! -d "$SOURCE_APP" ]]; then
  echo "[PresentationRuntime] LibreOffice.app missing from disk image" >&2
  exit 1
fi

rm -rf "$RUNTIME_DIR"
mkdir -p "$RUNTIME_DIR"
ditto "$SOURCE_APP" "${RUNTIME_DIR}/LibreOffice.app"
cat >"${RUNTIME_DIR}/THIRD_PARTY_NOTICES.md" <<EOF
LibreOffice ${VERSION} is bundled for local PowerPoint-to-PDF conversion.
LibreOffice is distributed by The Document Foundation under the Mozilla Public License v2.0.
Source and license information: https://www.libreoffice.org/about-us/licenses/
EOF

echo "[PresentationRuntime] Prepared LibreOffice ${VERSION} for macOS arm64"
