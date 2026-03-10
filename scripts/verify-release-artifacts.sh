#!/usr/bin/env bash
set -euo pipefail

# Verify that all critical release artifacts exist and are usable before packaging.
# This script logs file metadata, architecture information, and macOS runtime linkage
# so Ventura-incompatible builds fail before electron-builder packages them.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXPECTED_ARCH=""
MACOS_FLOOR_VERSION="${MACOS_FLOOR_VERSION:-${DISPLAY_HELPER_MACOSX_DEPLOYMENT_TARGET:-${MACOSX_DEPLOYMENT_TARGET:-13.0}}}"

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

normalize_version() {
  local version="${1:-0}"
  local major="${version%%.*}"
  local rest="${version#*.}"
  local minor="0"
  local patch="0"

  if [[ "$rest" != "$version" ]]; then
    minor="${rest%%.*}"
    if [[ "$rest" == *.* ]]; then
      patch="${rest#*.}"
    fi
  fi

  major="${major//[^0-9]/}"
  minor="${minor//[^0-9]/}"
  patch="${patch//[^0-9]/}"

  printf '%03d%03d%03d\n' "${major:-0}" "${minor:-0}" "${patch:-0}"
}

version_gt() {
  [[ "$(normalize_version "$1")" > "$(normalize_version "$2")" ]]
}

read_macos_minos() {
  local artifact="$1"
  local output=""
  local minos=""

  if command -v vtool >/dev/null 2>&1; then
    output="$(vtool -show-build "$artifact" 2>/dev/null || true)"
    minos="$(printf '%s\n' "$output" | awk '/minos / { print $2; exit }')"
    if [[ -n "$minos" ]]; then
      printf '%s\n' "$minos"
      return 0
    fi
  fi

  output="$(otool -l "$artifact" 2>/dev/null || true)"
  minos="$(printf '%s\n' "$output" | awk '
    /LC_BUILD_VERSION/ { in_build=1; next }
    in_build && /minos / { print $2; exit }
    /LC_VERSION_MIN_MACOSX/ { in_legacy=1; next }
    in_legacy && /version / { print $2; exit }
  ')"
  printf '%s\n' "$minos"
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

if [[ "$(uname -s)" == "Darwin" ]]; then
  REQUIRED_FILES+=("apps/bridge/native/display-helper/libSDL2-2.0.0.dylib")
fi

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

check_macos_install_name() {
  local relative_path="$1"
  local expected_install_name="$2"
  local absolute_path="$ROOT_DIR/$relative_path"
  local output
  local actual_install_name=""

  output="$(otool -D "$absolute_path" 2>/dev/null || true)"
  actual_install_name="$(printf '%s\n' "$output" | sed -n '2p')"

  if [[ -z "$actual_install_name" ]]; then
    echo "[Verify] Missing install name for $relative_path" >&2
    exit 1
  fi

  if [[ "$actual_install_name" != "$expected_install_name" ]]; then
    echo "[Verify] Unexpected install name for $relative_path: $actual_install_name" >&2
    echo "[Verify] Expected install name: $expected_install_name" >&2
    exit 1
  fi

  echo "[Verify] $relative_path install name -> $actual_install_name"
}

check_macos_loader_reference() {
  local relative_path="$1"
  local expected_reference="$2"
  local absolute_path="$ROOT_DIR/$relative_path"
  local output

  output="$(otool -L "$absolute_path")"
  echo "[Verify] $relative_path load commands:"
  printf '%s\n' "$output"

  if ! printf '%s\n' "$output" | grep -Fq "$expected_reference"; then
    echo "[Verify] Missing expected load reference for $relative_path: $expected_reference" >&2
    exit 1
  fi

  if printf '%s\n' "$output" | grep -Eq '/opt/homebrew|/usr/local|SDL2\.framework'; then
    echo "[Verify] $relative_path still contains an absolute SDL2 reference." >&2
    exit 1
  fi
}

check_macos_max_minos() {
  local relative_path="$1"
  local expected_max="$2"
  local absolute_path="$ROOT_DIR/$relative_path"
  local actual_minos

  actual_minos="$(read_macos_minos "$absolute_path")"
  if [[ -z "$actual_minos" ]]; then
    echo "[Verify] Could not determine minOS for $relative_path" >&2
    exit 1
  fi

  echo "[Verify] $relative_path minOS -> $actual_minos"
  if version_gt "$actual_minos" "$expected_max"; then
    echo "[Verify] $relative_path minOS $actual_minos exceeds allowed floor $expected_max" >&2
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

if [[ "$(uname -s)" == "Darwin" ]]; then
  check_architecture "apps/bridge/native/display-helper/libSDL2-2.0.0.dylib"
  check_macos_install_name \
    "apps/bridge/native/display-helper/libSDL2-2.0.0.dylib" \
    "@loader_path/libSDL2-2.0.0.dylib"
  check_macos_loader_reference \
    "apps/bridge/native/display-helper/display-helper" \
    "@loader_path/libSDL2-2.0.0.dylib"
  check_macos_max_minos "apps/bridge/native/display-helper/libSDL2-2.0.0.dylib" "$MACOS_FLOOR_VERSION"
  check_macos_max_minos "apps/bridge/native/display-helper/display-helper" "$MACOS_FLOOR_VERSION"
  check_macos_max_minos "apps/bridge/native/decklink-helper/decklink-helper" "$MACOS_FLOOR_VERSION"
fi

echo "[Verify] Release artifact verification completed successfully."
