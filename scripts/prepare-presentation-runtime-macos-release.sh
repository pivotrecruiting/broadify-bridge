#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Presentation runtime release asset preparation requires macOS." >&2
  exit 1
fi

if [[ "$(uname -m)" != "arm64" ]]; then
  echo "Presentation runtime release asset preparation requires Apple Silicon." >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR_DIR="${ROOT_DIR}/apps/bridge/vendor/presentation-runtime"
MANIFEST_PATH="${VENDOR_DIR}/manifest.json"
ARTIFACT_FILENAME="${PRESENTATION_RUNTIME_RELEASE_FILENAME:-$(node -pe "JSON.parse(require('fs').readFileSync('${MANIFEST_PATH}','utf8')).release_artifact.filename")}"
ARTIFACT_PATH="${VENDOR_DIR}/${ARTIFACT_FILENAME}"
LO_VERSION="$(node -pe "JSON.parse(require('fs').readFileSync('${MANIFEST_PATH}','utf8')).libreoffice_version")"

bash "${ROOT_DIR}/scripts/prepare-presentation-runtime-macos.sh"
bash "${ROOT_DIR}/scripts/sign-presentation-runtime-macos.sh"

lo_app="${VENDOR_DIR}/macos-arm64/LibreOffice.app"
soffice="${lo_app}/Contents/MacOS/soffice"

if [[ ! -d "$lo_app" || ! -x "$soffice" ]]; then
  echo "Prepared presentation runtime is incomplete." >&2
  exit 1
fi

codesign --verify --strict --deep "$lo_app"

tar -czf "$ARTIFACT_PATH" -C "$VENDOR_DIR" macos-arm64

sha256="$(shasum -a 256 "$ARTIFACT_PATH" | awk '{print $1}')"

echo "Prepared presentation runtime release bundle: ${ARTIFACT_PATH}"
echo "LibreOffice version: ${LO_VERSION}"
echo "SHA256: ${sha256}"
