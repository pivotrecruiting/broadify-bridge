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

hash_file() {
  local file_path="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file_path" | awk '{print $1}'
  else
    shasum -a 256 "$file_path" | awk '{print $1}'
  fi
}

manifest_hash() {
  node -e '
    const fs = require("fs");
    const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const entry = manifest.models.find((model) => model.name === process.argv[2]);
    process.stdout.write(entry?.sha256 || "");
  ' "$MANIFEST_PATH" "$1"
}

# download_model <manifest-name> <dest-file> <url> <required:0|1>
# Verifies against the pinned manifest hash. A required model that is unpinned,
# lacks a URL, or fails verification is a hard error; an optional model in those
# states is skipped so the build proceeds unaffected. Call an optional model with
# `|| ...` so a transient download failure never breaks the release.
download_model() {
  local name="$1" dest="$2" url="$3" required="$4"
  local expected
  expected="$(manifest_hash "$name")"

  if [[ -z "$expected" || "$expected" == "release-artifact-required" ]]; then
    if [[ "$required" == "1" ]]; then
      echo "No concrete $name sha256 in models/manifest.json." >&2
      return 1
    fi
    echo "$name not pinned in manifest; skipping (optional)."
    return 0
  fi

  if [[ -f "$dest" ]]; then
    local actual
    actual="$(hash_file "$dest")"
    if [[ "$actual" == "$expected" ]]; then
      echo "$name already present and verified ($actual)."
      return 0
    fi
    echo "Existing $name hash mismatch; re-downloading." >&2
  fi

  if [[ -z "$url" ]]; then
    if [[ "$required" == "1" ]]; then
      echo "URL for $name is not set; cannot download $dest." >&2
      return 1
    fi
    echo "URL for $name not set; skipping (optional)."
    return 0
  fi

  mkdir -p "$MODELS_DIR"
  local tmpfile
  tmpfile="$(mktemp)"
  # shellcheck disable=SC2064
  trap "rm -f '$tmpfile'" RETURN

  echo "Downloading $name from: $url"
  curl -fsSL --retry 5 --retry-delay 15 --retry-all-errors "$url" -o "$tmpfile"

  local download_hash
  download_hash="$(hash_file "$tmpfile")"
  if [[ "$download_hash" != "$expected" ]]; then
    echo "$name SHA256 mismatch." >&2
    echo "Expected: $expected" >&2
    echo "Actual:   $download_hash" >&2
    return 1
  fi

  mv "$tmpfile" "$dest"
  echo "Downloaded $name to $dest ($download_hash)"
}

# fp32 model: required — a failure here fails the build (current behaviour).
download_model "modnet" "$MODELS_DIR/modnet.onnx" "${MODNET_MODEL_URL:-}" 1

# fp16 model: optional half-precision variant for the BROADIFY_MEETING_KEYER_FP16
# experiment. No-op unless the manifest pins a real hash AND MODNET_FP16_MODEL_URL
# is set, so the fp32 keyer path is completely unaffected until fp16 is deployed.
# Never fatal: a missing/failed fp16 model just leaves the keyer on fp32.
download_model "modnet-fp16" "$MODELS_DIR/modnet_fp16.onnx" \
  "${MODNET_FP16_MODEL_URL:-}" 0 ||
  echo "fp16 MODNet model download failed; continuing on fp32 keyer." >&2
