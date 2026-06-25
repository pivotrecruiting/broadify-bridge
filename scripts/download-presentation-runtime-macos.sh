#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Skipping presentation runtime download on non-macOS."
  exit 0
fi

if [[ "$(uname -m)" != "arm64" ]]; then
  echo "Presentation runtime download is only supported on Apple Silicon macOS." >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST_PATH="${ROOT_DIR}/apps/bridge/vendor/presentation-runtime/manifest.json"
VENDOR_DIR="${ROOT_DIR}/apps/bridge/vendor/presentation-runtime"
RUNTIME_DIR="${VENDOR_DIR}/macos-arm64"
ARTIFACT_FILENAME="$(node -pe "JSON.parse(require('fs').readFileSync('${MANIFEST_PATH}','utf8')).release_artifact.filename")"

url="${PRESENTATION_RUNTIME_URL_ARM64:-}"
sha256="${PRESENTATION_RUNTIME_SHA256_ARM64:-}"

if [[ -z "$url" || -z "$sha256" ]]; then
  echo "Presentation runtime download URL or SHA256 is missing for arm64." >&2
  exit 1
fi

tmpfile="$(mktemp)"
trap 'rm -f "$tmpfile"' EXIT

echo "Downloading presentation runtime (arm64) from: $url"
curl -fsSL "$url" -o "$tmpfile"

download_hash="$(shasum -a 256 "$tmpfile" | awk '{print $1}')"
if [[ "$download_hash" != "$sha256" ]]; then
  echo "Presentation runtime SHA256 mismatch for arm64." >&2
  echo "Expected: $sha256" >&2
  echo "Actual:   $download_hash" >&2
  exit 1
fi

rm -rf "$RUNTIME_DIR"
mkdir -p "$VENDOR_DIR"
tar -xzf "$tmpfile" -C "$VENDOR_DIR"

lo_app="${RUNTIME_DIR}/LibreOffice.app"
soffice="${lo_app}/Contents/MacOS/soffice"

if [[ ! -d "$lo_app" ]]; then
  echo "Downloaded presentation runtime is missing ${lo_app}" >&2
  exit 1
fi

if [[ ! -x "$soffice" ]]; then
  echo "Downloaded presentation runtime is missing executable ${soffice}" >&2
  exit 1
fi

if [[ "${PRESENTATION_RUNTIME_REQUIRE_SIGNATURE:-1}" == "1" ]]; then
  codesign --verify --strict --deep "$lo_app"
  echo "Downloaded presentation runtime signature verified"
fi

echo "Prepared presentation runtime at ${RUNTIME_DIR}"
