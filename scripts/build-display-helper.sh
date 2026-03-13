#!/usr/bin/env bash
set -euo pipefail

if [[ "${SKIP_DISPLAY_HELPER_BUILD:-}" == "1" ]]; then
  echo "Skipping Display helper build (SKIP_DISPLAY_HELPER_BUILD=1)."
  exit 0
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNAME_S="$(uname -s)"

if [[ "$UNAME_S" == "Darwin" ]]; then
  bash "$ROOT_DIR/apps/bridge/native/display-helper/build.sh"
  # Sign for release when identity is set (CI/notarization)
  bash "$ROOT_DIR/scripts/sign-display-helper.sh"
  exit 0
fi

if [[ "$UNAME_S" == MINGW* || "$UNAME_S" == MSYS* || "$UNAME_S" == CYGWIN* ]]; then
  BUILD_PS1="$ROOT_DIR/apps/bridge/native/display-helper/build.ps1"
  if command -v cygpath >/dev/null 2>&1; then
    BUILD_PS1="$(cygpath -w "$BUILD_PS1")"
  fi
  if command -v powershell.exe >/dev/null 2>&1; then
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File \
      "$BUILD_PS1"
    exit 0
  fi
  if command -v pwsh >/dev/null 2>&1; then
    pwsh -NoProfile -File "$BUILD_PS1"
    exit 0
  fi
  echo "Skipping Display helper build on Windows: PowerShell not found." >&2
  exit 0
fi

echo "Skipping Display helper build on unsupported platform: $UNAME_S"
exit 0
