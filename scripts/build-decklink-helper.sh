#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Skipping DeckLink helper build on non-macOS."
  exit 0
fi

if [[ "${SKIP_DECKLINK_HELPER_BUILD:-}" == "1" ]]; then
  echo "Skipping DeckLink helper build (SKIP_DECKLINK_HELPER_BUILD=1)."
  exit 0
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

bash "$ROOT_DIR/apps/bridge/native/decklink-helper/build.sh"
