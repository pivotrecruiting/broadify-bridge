#!/usr/bin/env bash
# Builds the ATEM USB helper (macOS). Mirrors the DeckLink helper build:
# SDK headers come from the locally installed ATEM software (or an explicit
# ATEM_SDK_ROOT); the SDK runtime is loaded at runtime via the dispatch
# shim, so no framework is linked and no SDK files are shipped or committed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDK_ROOT="${ATEM_SDK_ROOT:-/Applications/Blackmagic ATEM Switchers/Developer SDK/Mac OS X}"
INCLUDE_DIR="${SDK_ROOT}/include"
HEADER_PATH="${INCLUDE_DIR}/BMDSwitcherAPI.h"
OUTPUT="${SCRIPT_DIR}/atem-usb-helper"

if [[ ! -f "${HEADER_PATH}" ]]; then
  echo "error: BMDSwitcherAPI.h not found under '${INCLUDE_DIR}'." >&2
  echo "       Install the Blackmagic ATEM software or set ATEM_SDK_ROOT." >&2
  exit 1
fi

SDK_IDL_SHA="$(shasum -a 256 "${HEADER_PATH}" | awk '{print substr($1, 1, 12)}')"
SDK_DISCOVERY_CLSID="n/a-macos"
SDK_VERSION="$(
  awk '
    {
      lower = tolower($0)
    }
    lower ~ /version[[:space:]]*[0-9]+(\.[0-9]+)+/ {
      for (i = 1; i <= NF; i++) {
        if (tolower($i) ~ /^version$/ && (i + 1) <= NF && $(i + 1) ~ /^[0-9]+(\.[0-9]+)+/) {
          print $(i + 1)
          exit
        }
        if (tolower($i) ~ /^version[[:space:]]*[0-9]+(\.[0-9]+)+/) {
          sub(/.*[Vv]ersion[[:space:]]*/, "", $i)
          print $i
          exit
        }
      }
    }
  ' "${HEADER_PATH}"
)"
SDK_VERSION="${SDK_VERSION:-unknown}"

clang++ -std=c++17 -O2 -Wall -Wextra \
  -I "${INCLUDE_DIR}" \
  -DHELPER_SDK_IDL_SHA=\"${SDK_IDL_SHA}\" \
  -DHELPER_SDK_DISCOVERY_CLSID=\"${SDK_DISCOVERY_CLSID}\" \
  -DHELPER_SDK_VERSION=\"${SDK_VERSION}\" \
  "${SCRIPT_DIR}/src/atem-usb-helper.cpp" \
  "${INCLUDE_DIR}/BMDSwitcherAPIDispatch.cpp" \
  -framework CoreFoundation \
  -o "${OUTPUT}"

echo "built ${OUTPUT}"
