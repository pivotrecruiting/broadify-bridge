#!/usr/bin/env bash
set -euo pipefail

# PGM helper (live program preview). macOS always; Windows only behind the
# build switch BROADIFY_PGM_WINDOWS=1 (ADR-0009), otherwise skipped as before.
if [[ "${SKIP_PGM_HELPER_BUILD:-}" == "1" ]]; then
  echo "Skipping PGM helper build (SKIP_PGM_HELPER_BUILD=1)."
  exit 0
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNAME_S="$(uname -s)"

if [[ "$UNAME_S" == "Darwin" ]]; then
  bash "$ROOT_DIR/apps/bridge/native/pgm-helper/build.sh"
  exit 0
fi

if [[ "$UNAME_S" == MINGW* || "$UNAME_S" == MSYS* || "$UNAME_S" == CYGWIN* ]] && [[ "${BROADIFY_PGM_WINDOWS:-}" == "1" ]]; then
  BUILD_PS1="$ROOT_DIR/apps/bridge/native/pgm-helper/build.ps1"
  if command -v cygpath >/dev/null 2>&1; then
    BUILD_PS1="$(cygpath -w "$BUILD_PS1")"
  fi
  if command -v powershell.exe >/dev/null 2>&1; then
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$BUILD_PS1"
    exit 0
  fi
  if command -v pwsh >/dev/null 2>&1; then
    pwsh -NoProfile -File "$BUILD_PS1"
    exit 0
  fi
  # The switch asks for the helper: unlike the unconditional skip below this is an error.
  echo "BROADIFY_PGM_WINDOWS=1 but PowerShell was not found; cannot build the PGM helper." >&2
  exit 1
fi

echo "Skipping PGM helper build on $UNAME_S (phase 1 ships macOS only)."
exit 0
