#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Skipping SDL2 macOS setup on non-macOS."
  exit 0
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REQUESTED_DEPLOYMENT_TARGET="${DISPLAY_HELPER_MACOSX_DEPLOYMENT_TARGET:-${MACOSX_DEPLOYMENT_TARGET:-13.0}}"
SDL2_SOURCE_VERSION="${SDL2_SOURCE_VERSION:-2.30.12}"
EXPECTED_MAX_MINOS="${MACOS_FLOOR_VERSION:-$REQUESTED_DEPLOYMENT_TARGET}"

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

write_github_env() {
  local bundle_dir="$1"
  local runtime_path="$2"
  local headers_dir="$3"

  if [[ -n "${GITHUB_ENV:-}" ]]; then
    {
      echo "SDL2_BUNDLE_DIR=${bundle_dir}"
      echo "SDL2_DYLIB_PATH=${runtime_path}"
      echo "SDL2_CFLAGS=-I${bundle_dir}/include -I${headers_dir}"
      echo "SDL2_LIBS=${runtime_path}"
    } >> "$GITHUB_ENV"
  fi
}

arch="$(uname -m)"
case "$arch" in
  arm64)
    bundle_arch="arm64"
    bundle_url="${SDL2_MACOS_URL_ARM64:-}"
    bundle_sha256="${SDL2_MACOS_SHA256_ARM64:-}"
    cmake_arch="arm64"
    ;;
  x86_64)
    bundle_arch="x64"
    bundle_url="${SDL2_MACOS_URL_X64:-}"
    bundle_sha256="${SDL2_MACOS_SHA256_X64:-}"
    cmake_arch="x86_64"
    ;;
  *)
    echo "Unsupported macOS architecture: ${arch}" >&2
    exit 1
    ;;
esac

if [[ -n "$bundle_url" && -n "$bundle_sha256" ]]; then
  echo "Using pinned SDL2 macOS bundle for ${bundle_arch}."
  bash "${ROOT_DIR}/scripts/download-sdl2-macos.sh"
  exit 0
fi

echo "Pinned SDL2 bundle not configured for ${bundle_arch}; building SDL2 ${SDL2_SOURCE_VERSION} from source."

bundle_dir="${ROOT_DIR}/apps/bridge/native/display-helper/.sdl2-bundle/${bundle_arch}"
temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT

archive_path="${temp_dir}/SDL2-${SDL2_SOURCE_VERSION}.tar.gz"
source_dir="${temp_dir}/src"
build_dir="${temp_dir}/build"
install_dir="${temp_dir}/install"

mkdir -p "$source_dir" "$build_dir" "$install_dir"
curl -fsSL "https://www.libsdl.org/release/SDL2-${SDL2_SOURCE_VERSION}.tar.gz" -o "$archive_path"
tar -xzf "$archive_path" -C "$source_dir"

src_root="$(find "$source_dir" -mindepth 1 -maxdepth 1 -type d -name 'SDL2-*' | head -n 1)"
if [[ -z "$src_root" ]]; then
  echo "Extracted SDL2 source directory not found." >&2
  exit 1
fi

cmake -S "$src_root" -B "$build_dir" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$install_dir" \
  -DCMAKE_OSX_DEPLOYMENT_TARGET="${REQUESTED_DEPLOYMENT_TARGET}" \
  -DCMAKE_OSX_ARCHITECTURES="${cmake_arch}"

cmake --build "$build_dir" --config Release --parallel
cmake --install "$build_dir" --config Release

runtime_path="${install_dir}/lib/libSDL2-2.0.0.dylib"
headers_dir="${install_dir}/include/SDL2"

if [[ ! -f "$runtime_path" ]]; then
  echo "Expected SDL2 dylib missing after source build: $runtime_path" >&2
  exit 1
fi

if [[ ! -f "${headers_dir}/SDL.h" ]]; then
  echo "Expected SDL2 headers missing after source build: ${headers_dir}/SDL.h" >&2
  exit 1
fi

runtime_minos="$(read_macos_minos "$runtime_path")"
if [[ -z "$runtime_minos" ]]; then
  echo "Could not determine built SDL2 runtime minOS." >&2
  exit 1
fi

echo "Built SDL2 runtime minOS: $runtime_minos"
if version_gt "$runtime_minos" "$EXPECTED_MAX_MINOS"; then
  echo "Built SDL2 runtime minOS ${runtime_minos} exceeds allowed floor ${EXPECTED_MAX_MINOS}." >&2
  exit 1
fi

rm -rf "$bundle_dir"
mkdir -p "${bundle_dir}/include/SDL2" "${bundle_dir}/lib"
cp -R "${headers_dir}/." "${bundle_dir}/include/SDL2/"
cp -f "$runtime_path" "${bundle_dir}/lib/libSDL2-2.0.0.dylib"
chmod u+w "${bundle_dir}/lib/libSDL2-2.0.0.dylib"

write_github_env "$bundle_dir" "${bundle_dir}/lib/libSDL2-2.0.0.dylib" "${bundle_dir}/include/SDL2"

echo "Prepared SDL2 bundle at ${bundle_dir}"
