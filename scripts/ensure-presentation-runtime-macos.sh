#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Skipping presentation runtime setup on non-macOS."
  exit 0
fi

if [[ "$(uname -m)" != "arm64" ]]; then
  echo "Presentation runtime is only bundled for Apple Silicon macOS builds."
  exit 0
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${ROOT_DIR}/apps/bridge/vendor/presentation-runtime/macos-arm64"
SOFFICE="${RUNTIME_DIR}/LibreOffice.app/Contents/MacOS/soffice"

url="${PRESENTATION_RUNTIME_URL_ARM64:-}"
sha256="${PRESENTATION_RUNTIME_SHA256_ARM64:-}"

if [[ -n "$url" && -n "$sha256" ]]; then
  echo "Using pinned presentation runtime bundle for arm64."
  bash "${ROOT_DIR}/scripts/download-presentation-runtime-macos.sh"
  exit 0
fi

if [[ -x "$SOFFICE" ]]; then
  echo "Using existing unpacked presentation runtime at ${RUNTIME_DIR}"
  exit 0
fi

echo "Pinned presentation runtime not configured; preparing LibreOffice from upstream DMG."
bash "${ROOT_DIR}/scripts/prepare-presentation-runtime-macos.sh"
