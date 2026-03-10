#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Skipping SDL2 macOS bundle download on non-macOS."
  exit 0
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXPECTED_MAX_MINOS="${MACOS_FLOOR_VERSION:-${DISPLAY_HELPER_MACOSX_DEPLOYMENT_TARGET:-${MACOSX_DEPLOYMENT_TARGET:-13.0}}}"

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

arch="$(uname -m)"
case "$arch" in
  arm64)
    url="${SDL2_MACOS_URL_ARM64:-}"
    sha256="${SDL2_MACOS_SHA256_ARM64:-}"
    bundle_arch="arm64"
    ;;
  x86_64)
    url="${SDL2_MACOS_URL_X64:-}"
    sha256="${SDL2_MACOS_SHA256_X64:-}"
    bundle_arch="x64"
    ;;
  *)
    echo "Unsupported macOS architecture: ${arch}" >&2
    exit 1
    ;;
esac

if [[ -z "$url" || -z "$sha256" ]]; then
  echo "SDL2 macOS bundle URL or SHA256 is missing for ${arch}." >&2
  exit 1
fi

bundle_dir="${ROOT_DIR}/apps/bridge/native/display-helper/.sdl2-bundle/${bundle_arch}"
tmpfile="$(mktemp)"
trap 'rm -f "$tmpfile"' EXIT

rm -rf "$bundle_dir"
mkdir -p "$bundle_dir"

echo "Downloading SDL2 macOS bundle (${bundle_arch}) from: $url"
curl -fsSL "$url" -o "$tmpfile"

download_hash="$(shasum -a 256 "$tmpfile" | awk '{print $1}')"
if [[ "$download_hash" != "$sha256" ]]; then
  echo "SDL2 macOS bundle SHA256 mismatch for ${bundle_arch}." >&2
  echo "Expected: $sha256" >&2
  echo "Actual:   $download_hash" >&2
  exit 1
fi

tar -xzf "$tmpfile" -C "$bundle_dir"

runtime_path="${bundle_dir}/lib/libSDL2-2.0.0.dylib"
headers_dir="${bundle_dir}/include/SDL2"

if [[ ! -f "$runtime_path" ]]; then
  echo "Downloaded SDL2 bundle is missing ${runtime_path}" >&2
  exit 1
fi

if [[ ! -f "${headers_dir}/SDL.h" ]]; then
  echo "Downloaded SDL2 bundle is missing ${headers_dir}/SDL.h" >&2
  exit 1
fi

runtime_minos="$(read_macos_minos "$runtime_path")"
if [[ -z "$runtime_minos" ]]; then
  echo "Could not determine SDL2 bundle minOS." >&2
  exit 1
fi

echo "Downloaded SDL2 runtime minOS: $runtime_minos"
if version_gt "$runtime_minos" "$EXPECTED_MAX_MINOS"; then
  echo "SDL2 bundle minOS ${runtime_minos} exceeds allowed floor ${EXPECTED_MAX_MINOS}." >&2
  exit 1
fi

if [[ -n "${GITHUB_ENV:-}" ]]; then
  {
    echo "SDL2_BUNDLE_DIR=${bundle_dir}"
    echo "SDL2_DYLIB_PATH=${runtime_path}"
    echo "SDL2_CFLAGS=-I${bundle_dir}/include -I${headers_dir}"
    echo "SDL2_LIBS=${runtime_path}"
  } >> "$GITHUB_ENV"
fi

echo "Prepared SDL2 bundle at ${bundle_dir}"
