#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Skipping DeckLink helper check on non-macOS."
  exit 0
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HELPER="$ROOT_DIR/apps/bridge/native/decklink-helper/decklink-helper"
EXPECTED_MAX_MINOS="${MACOS_FLOOR_VERSION:-${DECKLINK_HELPER_MACOSX_DEPLOYMENT_TARGET:-${MACOSX_DEPLOYMENT_TARGET:-13.0}}}"

if [[ ! -x "$HELPER" ]]; then
  echo "DeckLink helper missing or not executable at $HELPER" >&2
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

read_macos_minos() {
  local output
  output="$(vtool -show-build "$HELPER" 2>/dev/null || true)"
  printf '%s\n' "$output" | awk '/minos / { print $2; exit }'
}

helper_minos="$(read_macos_minos)"
if [[ -z "$helper_minos" ]]; then
  echo "Could not determine DeckLink helper minOS." >&2
  exit 1
fi

echo "DeckLink helper minOS: $helper_minos"
if [[ "$(normalize_version "$helper_minos")" > "$(normalize_version "$EXPECTED_MAX_MINOS")" ]]; then
  echo "DeckLink helper minOS $helper_minos exceeds allowed floor $EXPECTED_MAX_MINOS." >&2
  exit 1
fi

output="$("$HELPER" --playback 2>&1 || true)"
if echo "$output" | grep -q "Unknown mode: --playback"; then
  echo "DeckLink helper does not support --playback (outdated binary)." >&2
  exit 1
fi

echo "DeckLink helper playback mode is present."
