#!/usr/bin/env bash
set -euo pipefail

# Verify that all critical release artifacts exist and are usable before packaging.
# This script logs file metadata and architecture information to make release issues visible.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXPECTED_ARCH=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --arch)
      EXPECTED_ARCH="${2:-}"
      shift 2
      ;;
    *)
      echo "[Verify] Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$EXPECTED_ARCH" ]]; then
  EXPECTED_ARCH="$(uname -m)"
fi

normalize_arch() {
  case "$1" in
    arm64 | aarch64)
      echo "arm64"
      ;;
    x64 | x86_64 | amd64)
      echo "x86_64"
      ;;
    *)
      echo "$1"
      ;;
  esac
}

EXPECTED_ARCH_NORMALIZED="$(normalize_arch "$EXPECTED_ARCH")"
REQUIRED_FILES=(
  "dist-electron/main.js"
  "dist-react/index.html"
  "apps/bridge/dist/index.js"
  "apps/bridge/dist/services/graphics/renderer/electron-renderer-entry.js"
  "apps/bridge/native/framebus/build/Release/framebus.node"
  "apps/bridge/native/display-helper/display-helper"
  "apps/bridge/native/decklink-helper/decklink-helper"
)
EXECUTABLE_FILES=(
  "apps/bridge/native/display-helper/display-helper"
  "apps/bridge/native/decklink-helper/decklink-helper"
)

check_exists() {
  local relative_path="$1"
  local absolute_path="$ROOT_DIR/$relative_path"
  if [[ ! -e "$absolute_path" ]]; then
    echo "[Verify] Missing artifact: $relative_path" >&2
    exit 1
  fi
}

check_executable() {
  local relative_path="$1"
  local absolute_path="$ROOT_DIR/$relative_path"
  if [[ ! -x "$absolute_path" ]]; then
    echo "[Verify] Artifact is not executable: $relative_path" >&2
    exit 1
  fi
}

log_file_metadata() {
  local relative_path="$1"
  local absolute_path="$ROOT_DIR/$relative_path"
  local stat_output
  stat_output="$(stat -f "mode=%Sp size=%z bytes" "$absolute_path")"
  echo "[Verify] $relative_path -> $stat_output"
}

check_architecture() {
  local relative_path="$1"
  local absolute_path="$ROOT_DIR/$relative_path"
  local output
  output="$(file "$absolute_path")"
  echo "[Verify] $output"

  if [[ "$output" == *"universal"* ]]; then
    return
  fi
  if [[ "$output" != *"$EXPECTED_ARCH_NORMALIZED"* ]]; then
    echo "[Verify] Architecture mismatch for $relative_path (expected: $EXPECTED_ARCH_NORMALIZED)" >&2
    exit 1
  fi
}

echo "[Verify] Release artifact verification started (expected arch: $EXPECTED_ARCH_NORMALIZED)"

for file_path in "${REQUIRED_FILES[@]}"; do
  check_exists "$file_path"
  log_file_metadata "$file_path"
done

for file_path in "${EXECUTABLE_FILES[@]}"; do
  check_executable "$file_path"
done

check_architecture "apps/bridge/native/framebus/build/Release/framebus.node"
check_architecture "apps/bridge/native/display-helper/display-helper"
check_architecture "apps/bridge/native/decklink-helper/decklink-helper"

echo "[Verify] Release artifact verification completed successfully."
