#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Skipping ATEM USB helper build on non-macOS."
  exit 0
fi

if [[ "${SKIP_ATEM_USB_HELPER_BUILD:-}" == "1" ]]; then
  echo "Skipping ATEM USB helper build (SKIP_ATEM_USB_HELPER_BUILD=1)."
  exit 0
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

bash "$ROOT_DIR/apps/bridge/native/atem-usb-helper/build.sh"
