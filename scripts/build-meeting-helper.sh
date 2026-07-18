#!/usr/bin/env bash
set -euo pipefail

if [[ "${SKIP_MEETING_HELPER_BUILD:-}" == "1" ]]; then
  echo "Skipping Meeting helper build (SKIP_MEETING_HELPER_BUILD=1)."
  exit 0
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNAME_S="$(uname -s)"

if [[ "$UNAME_S" == "Darwin" ]]; then
  # macOS uses native CoreML MODNet with Apple Vision fallback. The optional
  # ONNX Runtime build requires macOS 14, so disabling it keeps the helper on
  # the supported macOS 13 floor. Overridable for local experimentation.
  export MEETING_HELPER_ENABLE_MODNET="${MEETING_HELPER_ENABLE_MODNET:-0}"
  bash "$ROOT_DIR/apps/bridge/native/meeting-helper/build.sh"
  exit 0
fi

if [[ "$UNAME_S" == MINGW* || "$UNAME_S" == MSYS* || "$UNAME_S" == CYGWIN* ]]; then
  BUILD_PS1="$ROOT_DIR/apps/bridge/native/meeting-helper/build.ps1"
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
  echo "Skipping Meeting helper build on Windows: PowerShell not found." >&2
  exit 0
fi

echo "Skipping Meeting helper build on unsupported platform: $UNAME_S"
exit 0
