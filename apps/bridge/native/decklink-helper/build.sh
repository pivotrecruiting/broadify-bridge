#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="${ROOT_DIR}/src"
OUT_DIR="${ROOT_DIR}"
DEPLOYMENT_TARGET="${DECKLINK_HELPER_MACOSX_DEPLOYMENT_TARGET:-${MACOSX_DEPLOYMENT_TARGET:-13.0}}"

SDK_ROOT="${DECKLINK_SDK_ROOT:-/Users/dennisschaible/SDKs/Blackmagic}"
INCLUDE_DIR="${SDK_ROOT}/Mac/include"
FRAMEWORK_PATH="${DECKLINK_FRAMEWORK_PATH:-/Library/Frameworks}"
DISPATCH_SRC="${INCLUDE_DIR}/DeckLinkAPIDispatch.cpp"

if [[ ! -d "${INCLUDE_DIR}" ]]; then
  echo "DeckLink SDK headers not found at ${INCLUDE_DIR}" >&2
  exit 1
fi

if [[ ! -d "${FRAMEWORK_PATH}/DeckLinkAPI.framework" ]]; then
  echo "DeckLinkAPI.framework not found at ${FRAMEWORK_PATH}" >&2
  echo "Install Blackmagic Desktop Video or set DECKLINK_FRAMEWORK_PATH." >&2
  exit 1
fi

clang++ \
  -std=c++17 \
  -Wall \
  -Wextra \
  -O2 \
  -mmacosx-version-min="${DEPLOYMENT_TARGET}" \
  -I "${INCLUDE_DIR}" \
  -F "${FRAMEWORK_PATH}" \
  -framework CoreFoundation \
  -framework DeckLinkAPI \
  "${DISPATCH_SRC}" \
  "${SRC_DIR}/decklink-helper.cpp" \
  -o "${OUT_DIR}/decklink-helper"

echo "Built ${OUT_DIR}/decklink-helper"
echo "Using deployment target ${DEPLOYMENT_TARGET}"
