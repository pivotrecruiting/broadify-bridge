#!/usr/bin/env bash
# Builds the ATEM USB helper (macOS). Mirrors the DeckLink helper build:
# SDK headers come from the locally installed ATEM software (or an explicit
# ATEM_SDK_ROOT); the SDK runtime is loaded at runtime via the dispatch
# shim, so no framework is linked and no SDK files are shipped or committed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDK_ROOT="${ATEM_SDK_ROOT:-/Applications/Blackmagic ATEM Switchers/Developer SDK/Mac OS X}"
INCLUDE_DIR="${SDK_ROOT}/include"
OUTPUT="${SCRIPT_DIR}/atem-usb-helper"

if [[ ! -f "${INCLUDE_DIR}/BMDSwitcherAPI.h" ]]; then
  echo "error: BMDSwitcherAPI.h not found under '${INCLUDE_DIR}'." >&2
  echo "       Install the Blackmagic ATEM software or set ATEM_SDK_ROOT." >&2
  exit 1
fi

clang++ -std=c++17 -O2 -Wall -Wextra \
  -I "${INCLUDE_DIR}" \
  "${SCRIPT_DIR}/src/atem-usb-helper.cpp" \
  "${INCLUDE_DIR}/BMDSwitcherAPIDispatch.cpp" \
  -framework CoreFoundation \
  -o "${OUTPUT}"

echo "built ${OUTPUT}"
