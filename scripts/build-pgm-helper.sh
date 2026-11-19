#!/usr/bin/env bash
set -euo pipefail

# PGM helper (live program preview). macOS only in phase 1; Windows follows.
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

echo "Skipping PGM helper build on $UNAME_S (phase 1 ships macOS only)."
exit 0
