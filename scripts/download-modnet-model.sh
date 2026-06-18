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
