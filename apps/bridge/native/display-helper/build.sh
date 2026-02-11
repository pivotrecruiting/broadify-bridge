#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="${ROOT_DIR}/src"
OUT_DIR="${ROOT_DIR}"
FRAMEBUS_INCLUDE="${ROOT_DIR}/../framebus/include"

if [[ ! -d "${FRAMEBUS_INCLUDE}" ]]; then
  echo "FrameBus include not found at ${FRAMEBUS_INCLUDE}" >&2
  exit 1
fi

# Prefer sdl2-config if available (Homebrew, etc.)
if command -v sdl2-config >/dev/null 2>&1; then
  SDL_CFLAGS=$(sdl2-config --cflags)
  SDL_LIBS=$(sdl2-config --libs)
else
  # Fallback: assume SDL2 framework in /Library/Frameworks or Homebrew
  if [[ -d "/Library/Frameworks/SDL2.framework" ]]; then
    SDL_CFLAGS="-I/Library/Frameworks/SDL2.framework/Headers -F/Library/Frameworks"
    SDL_LIBS="-framework SDL2 -F/Library/Frameworks"
  elif [[ -d "/opt/homebrew/opt/sdl2/include" ]]; then
    SDL_CFLAGS="-I/opt/homebrew/opt/sdl2/include"
    SDL_LIBS="-L/opt/homebrew/opt/sdl2/lib -lSDL2"
  elif [[ -d "/usr/local/opt/sdl2/include" ]]; then
    SDL_CFLAGS="-I/usr/local/opt/sdl2/include"
    SDL_LIBS="-L/usr/local/opt/sdl2/lib -lSDL2"
  else
    echo "SDL2 not found. Install via: brew install sdl2" >&2
    exit 1
  fi
fi

clang++ \
  -std=c++17 \
  -Wall \
  -Wextra \
  -O2 \
  -I "${FRAMEBUS_INCLUDE}" \
  ${SDL_CFLAGS} \
  "${SRC_DIR}/display-helper.cpp" \
  -o "${OUT_DIR}/display-helper" \
  ${SDL_LIBS}

echo "Built ${OUT_DIR}/display-helper"
