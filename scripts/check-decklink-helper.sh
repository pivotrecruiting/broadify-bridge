#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Skipping DeckLink helper check on non-macOS."
  exit 0
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HELPER="$ROOT_DIR/apps/bridge/native/decklink-helper/decklink-helper"

if [[ ! -x "$HELPER" ]]; then
  echo "DeckLink helper missing or not executable at $HELPER" >&2
  exit 1
fi

output="$("$HELPER" --playback 2>&1 || true)"
if echo "$output" | grep -q "Unknown mode: --playback"; then
  echo "DeckLink helper does not support --playback (outdated binary)." >&2
  exit 1
fi

echo "DeckLink helper playback mode is present."
