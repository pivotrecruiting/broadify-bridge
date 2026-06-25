#!/usr/bin/env bash
# Re-sign the bundled LibreOffice.app with the Broadify Developer ID identity.
# Used when preparing the pinned release asset; release CI downloads the pre-signed bundle.

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[PresentationRuntime] macOS is required" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${ROOT_DIR}/apps/bridge/vendor/presentation-runtime/macos-arm64"
APP_PATH="${RUNTIME_DIR}/LibreOffice.app"
ENTITLEMENTS="${ROOT_DIR}/build/entitlements.mac.inherit.plist"
IDENTITY="${APPLE_SIGNING_IDENTITY:-${CSC_NAME:-}}"

if [[ -z "$IDENTITY" ]]; then
  echo "[PresentationRuntime] APPLE_SIGNING_IDENTITY (or CSC_NAME) is required to sign LibreOffice.app" >&2
  exit 1
fi

if [[ ! -d "$APP_PATH" ]]; then
  echo "[PresentationRuntime] Missing LibreOffice.app at ${APP_PATH}" >&2
  exit 1
fi

if [[ ! -f "$ENTITLEMENTS" ]]; then
  echo "[PresentationRuntime] Missing entitlements file at ${ENTITLEMENTS}" >&2
  exit 1
fi

echo "[PresentationRuntime] Clearing extended attributes on LibreOffice.app"
xattr -cr "$APP_PATH" 2>/dev/null || true

echo "[PresentationRuntime] Signing LibreOffice.app with identity: ${IDENTITY}"
codesign --force --deep --options runtime \
  --entitlements "$ENTITLEMENTS" \
  --sign "$IDENTITY" \
  "$APP_PATH"

codesign --verify --strict --deep --verbose=2 "$APP_PATH"
echo "[PresentationRuntime] LibreOffice.app signing verification ok"
