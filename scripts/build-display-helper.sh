#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Skipping Display helper build on non-macOS."
  exit 0
fi

if [[ "${SKIP_DISPLAY_HELPER_BUILD:-}" == "1" ]]; then
  echo "Skipping Display helper build (SKIP_DISPLAY_HELPER_BUILD=1)."
  exit 0
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

bash "$ROOT_DIR/apps/bridge/native/display-helper/build.sh"

# Sign for release when identity is set (CI/notarization)
bash "$ROOT_DIR/scripts/sign-display-helper.sh"
