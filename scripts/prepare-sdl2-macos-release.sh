#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "SDL2 macOS release bundle preparation requires macOS." >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REQUESTED_DEPLOYMENT_TARGET="${DISPLAY_HELPER_MACOSX_DEPLOYMENT_TARGET:-${MACOSX_DEPLOYMENT_TARGET:-13.0}}"
OUTPUT_DIR="${ROOT_DIR}/apps/bridge/native/display-helper"

arch="$(uname -m)"
case "$arch" in
  arm64)
    artifact_arch="arm64"
    ;;
  x86_64)
    artifact_arch="x64"
    ;;
  *)
    echo "Unsupported macOS architecture: ${arch}" >&2
    exit 1
    ;;
esac

RELEASE_FILENAME="${SDL2_MACOS_RELEASE_FILENAME:-sdl2-macos-${artifact_arch}.tar.gz}"
ARTIFACT_PATH="${OUTPUT_DIR}/${RELEASE_FILENAME}"

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

find_sdl_dylib_in_dir() {
  local search_dir="$1"
  if [[ -z "$search_dir" || ! -d "$search_dir" ]]; then
    return 1
  fi

  if [[ -f "${search_dir}/libSDL2-2.0.0.dylib" ]]; then
    printf '%s\n' "${search_dir}/libSDL2-2.0.0.dylib"
    return 0
  fi

  local candidate
  candidate="$(find "$search_dir" -maxdepth 1 -name 'libSDL2*.dylib' -print 2>/dev/null | head -n 1 || true)"
  if [[ -n "$candidate" ]]; then
    printf '%s\n' "$candidate"
    return 0
  fi

  return 1
}

find_headers_dir() {
  local base="$1"
  if [[ -z "$base" || ! -d "$base" ]]; then
    return 1
  fi

  if [[ -f "${base}/SDL.h" ]]; then
    printf '%s\n' "$base"
    return 0
  fi

  if [[ -f "${base}/SDL2/SDL.h" ]]; then
    printf '%s\n' "${base}/SDL2"
    return 0
  fi

  return 1
}

SDL_RUNTIME_SOURCE="${SDL2_DYLIB_PATH:-}"
SDL_HEADERS_SOURCE="${SDL2_HEADERS_DIR:-}"

if [[ -z "$SDL_RUNTIME_SOURCE" && -n "${SDL2_LIBS:-}" ]]; then
  for token in ${SDL2_LIBS}; do
    if [[ "$token" == -L* ]]; then
      SDL_RUNTIME_SOURCE="$(find_sdl_dylib_in_dir "${token#-L}" || true)"
      [[ -n "$SDL_RUNTIME_SOURCE" ]] && break
    elif [[ "$token" == *.dylib && -f "$token" ]]; then
      SDL_RUNTIME_SOURCE="$token"
      break
    fi
  done
fi

if [[ -z "$SDL_HEADERS_SOURCE" && -n "${SDL2_CFLAGS:-}" ]]; then
  for token in ${SDL2_CFLAGS}; do
    if [[ "$token" == -I* ]]; then
      SDL_HEADERS_SOURCE="$(find_headers_dir "${token#-I}" || true)"
      [[ -n "$SDL_HEADERS_SOURCE" ]] && break
    fi
  done
fi

if [[ -z "$SDL_RUNTIME_SOURCE" || -z "$SDL_HEADERS_SOURCE" ]]; then
  if command -v sdl2-config >/dev/null 2>&1; then
    if [[ -z "$SDL_RUNTIME_SOURCE" ]]; then
      for token in $(sdl2-config --libs); do
        if [[ "$token" == -L* ]]; then
          SDL_RUNTIME_SOURCE="$(find_sdl_dylib_in_dir "${token#-L}" || true)"
          [[ -n "$SDL_RUNTIME_SOURCE" ]] && break
        fi
      done
    fi
    if [[ -z "$SDL_HEADERS_SOURCE" ]]; then
      for token in $(sdl2-config --cflags); do
        if [[ "$token" == -I* ]]; then
          SDL_HEADERS_SOURCE="$(find_headers_dir "${token#-I}" || true)"
          [[ -n "$SDL_HEADERS_SOURCE" ]] && break
        fi
      done
    fi
  fi
fi

if [[ -z "$SDL_RUNTIME_SOURCE" || -z "$SDL_HEADERS_SOURCE" ]]; then
  if [[ -f "/Library/Frameworks/SDL2.framework/Versions/A/SDL2" ]]; then
    [[ -z "$SDL_RUNTIME_SOURCE" ]] && SDL_RUNTIME_SOURCE="/Library/Frameworks/SDL2.framework/Versions/A/SDL2"
    [[ -z "$SDL_HEADERS_SOURCE" ]] && SDL_HEADERS_SOURCE="/Library/Frameworks/SDL2.framework/Headers"
  elif [[ -f "/opt/homebrew/lib/libSDL2-2.0.0.dylib" ]]; then
    [[ -z "$SDL_RUNTIME_SOURCE" ]] && SDL_RUNTIME_SOURCE="/opt/homebrew/lib/libSDL2-2.0.0.dylib"
    [[ -z "$SDL_HEADERS_SOURCE" ]] && SDL_HEADERS_SOURCE="$(find_headers_dir "/opt/homebrew/include" || true)"
  elif [[ -f "/usr/local/lib/libSDL2-2.0.0.dylib" ]]; then
    [[ -z "$SDL_RUNTIME_SOURCE" ]] && SDL_RUNTIME_SOURCE="/usr/local/lib/libSDL2-2.0.0.dylib"
    [[ -z "$SDL_HEADERS_SOURCE" ]] && SDL_HEADERS_SOURCE="$(find_headers_dir "/usr/local/include" || true)"
  fi
fi

if [[ -z "$SDL_RUNTIME_SOURCE" || ! -f "$SDL_RUNTIME_SOURCE" ]]; then
  echo "SDL2 runtime not found. Set SDL2_DYLIB_PATH or install SDL2." >&2
  exit 1
fi

if [[ -z "$SDL_HEADERS_SOURCE" || ! -d "$SDL_HEADERS_SOURCE" ]]; then
  echo "SDL2 headers not found. Set SDL2_HEADERS_DIR or install SDL2 headers." >&2
  exit 1
fi

runtime_minos="$(read_macos_minos "$SDL_RUNTIME_SOURCE")"
if [[ -z "$runtime_minos" ]]; then
  echo "Could not determine SDL2 runtime minOS." >&2
  exit 1
fi

if version_gt "$runtime_minos" "$REQUESTED_DEPLOYMENT_TARGET"; then
  echo "SDL2 runtime minOS ${runtime_minos} exceeds requested deployment target ${REQUESTED_DEPLOYMENT_TARGET}." >&2
  echo "Build or supply a Ventura-compatible SDL2 runtime first." >&2
  exit 1
fi

temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT

mkdir -p "${temp_dir}/include/SDL2" "${temp_dir}/lib"
cp -R "${SDL_HEADERS_SOURCE}/." "${temp_dir}/include/SDL2/"
cp -f "$SDL_RUNTIME_SOURCE" "${temp_dir}/lib/libSDL2-2.0.0.dylib"
chmod u+w "${temp_dir}/lib/libSDL2-2.0.0.dylib"

tar -czf "$ARTIFACT_PATH" -C "$temp_dir" include lib

sha256="$(shasum -a 256 "$ARTIFACT_PATH" | awk '{print $1}')"

echo "Prepared SDL2 macOS release bundle: $ARTIFACT_PATH"
echo "SDL2 runtime minOS: $runtime_minos"
echo "SHA256: $sha256"
