#!/usr/bin/env bash
set -euo pipefail

if [[ "${SKIP_MODNET_MODEL_DOWNLOAD:-}" == "1" ]]; then
  echo "Skipping MODNet model download (SKIP_MODNET_MODEL_DOWNLOAD=1)."
  exit 0
fi

is_windows_platform() {
  case "$(uname -s)" in
    MINGW* | MSYS* | CYGWIN* | Windows_NT) return 0 ;;
    *) return 1 ;;
  esac
}

if ! is_windows_platform; then
  echo "Skipping MODNet model download on non-Windows."
  exit 0
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODELS_DIR="$ROOT_DIR/apps/bridge/native/meeting-helper/models"
MANIFEST_PATH="$MODELS_DIR/manifest.json"
MODEL_PATH="$MODELS_DIR/modnet.onnx"
SELFIE_MODEL_PATH="$MODELS_DIR/selfie_landscape.onnx"

read_expected_hash() {
  node -e '
    const fs = require("fs");
    const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const entry = manifest.models.find((model) => model.name === "modnet");
    process.stdout.write(entry?.sha256 || "");
  ' "$MANIFEST_PATH"
}

hash_file() {
  local file_path="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file_path" | awk '{print $1}'
  else
    shasum -a 256 "$file_path" | awk '{print $1}'
  fi
}

EXPECTED_HASH="$(read_expected_hash)"
if [[ -z "$EXPECTED_HASH" || "$EXPECTED_HASH" == "release-artifact-required" ]]; then
  echo "No concrete MODNet sha256 in models/manifest.json." >&2
  exit 1
fi

if [[ -f "$MODEL_PATH" ]]; then
  ACTUAL_HASH="$(hash_file "$MODEL_PATH")"
  if [[ "$ACTUAL_HASH" == "$EXPECTED_HASH" ]]; then
    echo "MODNet model already present and verified ($ACTUAL_HASH)."
    exit 0
  fi
  echo "Existing MODNet model hash mismatch; re-downloading." >&2
fi

url="${MODNET_MODEL_URL:-}"
if [[ -z "$url" ]]; then
  echo "MODNET_MODEL_URL is not set; cannot download modnet.onnx." >&2
  exit 1
fi

mkdir -p "$MODELS_DIR"
tmpfile="$(mktemp)"

cleanup() {
  rm -f "$tmpfile"
}
trap cleanup EXIT

echo "Downloading MODNet model from: $url"
curl -fsSL \
  --retry 5 \
  --retry-delay 15 \
  --retry-all-errors \
  "$url" \
  -o "$tmpfile"

download_hash="$(hash_file "$tmpfile")"
if [[ "$download_hash" != "$EXPECTED_HASH" ]]; then
  echo "MODNet model SHA256 mismatch." >&2
  echo "Expected: $EXPECTED_HASH" >&2
  echo "Actual:   $download_hash" >&2
  exit 1
fi

mv "$tmpfile" "$MODEL_PATH"
trap - EXIT
echo "Downloaded MODNet model to $MODEL_PATH ($download_hash)"

read_selfie_hash() {
  node -e '
    const fs = require("fs");
    const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const entry = manifest.models.find((model) => model.name === "selfie_landscape");
    process.stdout.write(entry?.sha256 || "");
  ' "$MANIFEST_PATH"
}

SELFIE_URL="${SELFIE_LANDSCAPE_MODEL_URL:-}"
SELFIE_HASH="$(read_selfie_hash)"
if [[ -z "$SELFIE_URL" ]]; then
  echo "Skipping optional Selfie Segmenter model download (SELFIE_LANDSCAPE_MODEL_URL is not set)."
  exit 0
fi
if [[ -z "$SELFIE_HASH" || "$SELFIE_HASH" == "release-artifact-required" ]]; then
  echo "Skipping optional Selfie Segmenter model download (manifest hash is not concrete)."
  exit 0
fi
if [[ -f "$SELFIE_MODEL_PATH" ]]; then
  ACTUAL_SELFIE_HASH="$(hash_file "$SELFIE_MODEL_PATH")"
  if [[ "$ACTUAL_SELFIE_HASH" == "$SELFIE_HASH" ]]; then
    echo "Selfie Segmenter model already present and verified ($ACTUAL_SELFIE_HASH)."
    exit 0
  fi
  echo "Existing Selfie Segmenter model hash mismatch; re-downloading." >&2
fi

selfie_tmpfile="$(mktemp)"
trap 'rm -f "$selfie_tmpfile"' EXIT
echo "Downloading Selfie Segmenter model from: $SELFIE_URL"
curl -fsSL --retry 5 --retry-delay 15 --retry-all-errors "$SELFIE_URL" \
  -o "$selfie_tmpfile"
download_selfie_hash="$(hash_file "$selfie_tmpfile")"
if [[ "$download_selfie_hash" != "$SELFIE_HASH" ]]; then
  echo "Selfie Segmenter model SHA256 mismatch." >&2
  echo "Expected: $SELFIE_HASH" >&2
  echo "Actual:   $download_selfie_hash" >&2
  exit 1
fi
mv "$selfie_tmpfile" "$SELFIE_MODEL_PATH"
trap - EXIT
echo "Downloaded Selfie Segmenter model to $SELFIE_MODEL_PATH ($download_selfie_hash)"
