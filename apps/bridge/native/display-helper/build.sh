#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="${ROOT_DIR}/src"
OUT_DIR="${ROOT_DIR}"
FRAMEBUS_INCLUDE="${ROOT_DIR}/../framebus/include"
OUTPUT_BINARY="${OUT_DIR}/display-helper"
OUTPUT_RUNTIME="${OUT_DIR}/libSDL2-2.0.0.dylib"
REQUESTED_DEPLOYMENT_TARGET="${DISPLAY_HELPER_MACOSX_DEPLOYMENT_TARGET:-${MACOSX_DEPLOYMENT_TARGET:-13.0}}"
STRICT_MINOS="${SDL2_STRICT_MINOS:-0}"

if [[ ! -d "${FRAMEBUS_INCLUDE}" ]]; then
  echo "FrameBus include not found at ${FRAMEBUS_INCLUDE}" >&2
  exit 1
fi

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

SDL_CFLAGS="${SDL2_CFLAGS:-}"
SDL_LIBS="${SDL2_LIBS:-}"
SDL_RUNTIME_SOURCE="${SDL2_DYLIB_PATH:-}"

if [[ -n "$SDL_CFLAGS" && -z "$SDL_LIBS" ]]; then
  echo "SDL2_CFLAGS is set but SDL2_LIBS is missing." >&2
  exit 1
fi

if [[ -z "$SDL_CFLAGS" || -z "$SDL_LIBS" ]]; then
  if command -v sdl2-config >/dev/null 2>&1; then
    SDL_CFLAGS="$(sdl2-config --cflags)"
    SDL_LIBS="$(sdl2-config --libs)"
  fi
fi

if [[ -z "$SDL_RUNTIME_SOURCE" && -n "$SDL_LIBS" ]]; then
  for token in $SDL_LIBS; do
    if [[ "$token" == -L* ]]; then
      if SDL_RUNTIME_SOURCE="$(find_sdl_dylib_in_dir "${token#-L}")"; then
        break
      fi
    fi
  done
fi

if [[ -z "$SDL_CFLAGS" || -z "$SDL_LIBS" || -z "$SDL_RUNTIME_SOURCE" ]]; then
  if [[ -f "/Library/Frameworks/SDL2.framework/Versions/A/SDL2" ]]; then
    SDL_CFLAGS="-I/Library/Frameworks/SDL2.framework/Headers -F/Library/Frameworks"
    SDL_LIBS="-framework SDL2 -F/Library/Frameworks"
    SDL_RUNTIME_SOURCE="/Library/Frameworks/SDL2.framework/Versions/A/SDL2"
  elif [[ -f "/opt/homebrew/lib/libSDL2-2.0.0.dylib" ]]; then
    SDL_CFLAGS="-I/opt/homebrew/include -I/opt/homebrew/include/SDL2"
    SDL_LIBS="-L/opt/homebrew/lib -lSDL2"
    SDL_RUNTIME_SOURCE="/opt/homebrew/lib/libSDL2-2.0.0.dylib"
  elif [[ -f "/usr/local/lib/libSDL2-2.0.0.dylib" ]]; then
    SDL_CFLAGS="-I/usr/local/include -I/usr/local/include/SDL2"
    SDL_LIBS="-L/usr/local/lib -lSDL2"
    SDL_RUNTIME_SOURCE="/usr/local/lib/libSDL2-2.0.0.dylib"
  fi
fi

if [[ -z "$SDL_CFLAGS" || -z "$SDL_LIBS" || -z "$SDL_RUNTIME_SOURCE" ]]; then
  echo "SDL2 not found. Provide SDL2_CFLAGS/SDL2_LIBS/SDL2_DYLIB_PATH or install SDL2." >&2
  exit 1
fi

if [[ ! -f "$SDL_RUNTIME_SOURCE" ]]; then
  echo "SDL2 runtime not found at ${SDL_RUNTIME_SOURCE}" >&2
  exit 1
fi

effective_deployment_target="$REQUESTED_DEPLOYMENT_TARGET"
runtime_minos="$(read_macos_minos "$SDL_RUNTIME_SOURCE")"
if [[ -n "$runtime_minos" && "$(normalize_version "$runtime_minos")" != "000000000" ]]; then
  if version_gt "$runtime_minos" "$effective_deployment_target"; then
    if [[ "$STRICT_MINOS" == "1" ]]; then
      echo "SDL2 runtime minOS ${runtime_minos} exceeds requested deployment target ${effective_deployment_target}." >&2
      echo "Provide a Ventura-compatible SDL2 runtime via SDL2_DYLIB_PATH or build against an older SDL2 package." >&2
      exit 1
    fi
    echo "SDL2 runtime requires macOS ${runtime_minos}; upgrading deployment target from ${effective_deployment_target}." >&2
    effective_deployment_target="$runtime_minos"
  fi
fi

export MACOSX_DEPLOYMENT_TARGET="$effective_deployment_target"

if command -v xcrun >/dev/null 2>&1; then
  SDKROOT="$(xcrun --sdk macosx --show-sdk-path 2>/dev/null || true)"
  if [[ -n "${SDKROOT:-}" ]]; then
    export SDKROOT
  fi
fi

rm -f "$OUTPUT_BINARY" "$OUTPUT_RUNTIME"
cp -f "$SDL_RUNTIME_SOURCE" "$OUTPUT_RUNTIME"
chmod u+w "$OUTPUT_RUNTIME"

clang++ \
  -std=c++17 \
  -Wall \
  -Wextra \
  -O2 \
  -mmacosx-version-min="${MACOSX_DEPLOYMENT_TARGET}" \
  -I "${FRAMEBUS_INCLUDE}" \
  ${SDL_CFLAGS} \
  "${SRC_DIR}/display-helper.cpp" \
  -o "${OUTPUT_BINARY}" \
  ${SDL_LIBS}

chmod u+w "$OUTPUT_BINARY"

helper_sdl_reference="$(otool -L "$OUTPUT_BINARY" | awk 'NR > 1 && /SDL2/ { print $1; exit }')"
if [[ -z "$helper_sdl_reference" ]]; then
  echo "Built display-helper does not reference an SDL2 runtime." >&2
  exit 1
fi

install_name_tool -id "@loader_path/libSDL2-2.0.0.dylib" "$OUTPUT_RUNTIME"
install_name_tool -change "$helper_sdl_reference" "@loader_path/libSDL2-2.0.0.dylib" "$OUTPUT_BINARY"

echo "Built ${OUTPUT_BINARY}"
echo "Bundled SDL2 runtime at ${OUTPUT_RUNTIME}"
echo "Using deployment target ${MACOSX_DEPLOYMENT_TARGET}"
