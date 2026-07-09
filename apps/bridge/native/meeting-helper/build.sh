#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="${ROOT_DIR}/build"

cmake -S "${ROOT_DIR}" -B "${BUILD_DIR}" -DCMAKE_BUILD_TYPE="${CMAKE_BUILD_TYPE:-Release}"
cmake --build "${BUILD_DIR}" --config "${CMAKE_BUILD_TYPE:-Release}"

if [[ "$(uname -s)" == "Darwin" ]]; then
  APP_SOURCE=""
  for candidate in \
    "${BUILD_DIR}/BroadifyMeetingHelper.app" \
    "${BUILD_DIR}/meeting-helper.app" \
    "${BUILD_DIR}/Release/BroadifyMeetingHelper.app" \
    "${BUILD_DIR}/Release/meeting-helper.app"; do
    if [[ -d "${candidate}" ]]; then
      APP_SOURCE="${candidate}"
      break
    fi
  done

  if [[ -z "${APP_SOURCE}" ]]; then
    echo "Meeting helper app bundle not found under ${BUILD_DIR}" >&2
    exit 1
  fi

  rm -rf "${ROOT_DIR}/Broadify Bridge Meeting Helper.app"
  cp -R "${APP_SOURCE}" "${ROOT_DIR}/Broadify Bridge Meeting Helper.app"
  chmod -R u+w "${ROOT_DIR}/Broadify Bridge Meeting Helper.app"

  SIGNING_IDENTITY="${MEETING_HELPER_SIGNING_IDENTITY:-}"
  if [[ -z "${SIGNING_IDENTITY}" ]]; then
    SIGNING_IDENTITY="$(
      security find-identity -v -p codesigning 2>/dev/null \
        | sed -n 's/.*"\(Developer ID Application:.*(PG38DC5RG9)\)"/\1/p' \
        | head -n 1
    )"
  fi
  # Dev fallback: with no Developer ID cert on the machine, sign with a locally
  # created stable identity ("Broadify Dev Signing" self-signed, or an Apple
  # Development cert). Ad-hoc signatures change on every build, which
  # invalidates the macOS camera (TCC) grant and breaks the meeting camera after
  # each rebuild. `-p` (not `-v`) so an untrusted self-signed identity is found.
  if [[ -z "${SIGNING_IDENTITY}" ]]; then
    SIGNING_IDENTITY="$(
      security find-identity -p codesigning 2>/dev/null \
        | grep -oE '"(Broadify Dev Signing|Apple Development: [^"]*)"' \
        | tr -d '"' \
        | head -n 1
    )"
  fi

  # With MODNet enabled the helper loads the third-party ONNX Runtime dylib,
  # which is signed by a different team; hardened-runtime library validation
  # would reject it and the helper could not launch. Sign with the relaxed
  # entitlements (disable-library-validation) only in that case; the default
  # (MODNet-off, i.e. release) keeps the strict base entitlements untouched.
  ENTITLEMENTS_FILE="${ROOT_DIR}/macos/BroadifyMeetingHelper.entitlements"
  if [[ "${MEETING_HELPER_ENABLE_MODNET:-1}" == "1" ]]; then
    ENTITLEMENTS_FILE="${ROOT_DIR}/macos/BroadifyMeetingHelper.modnet.entitlements"
  fi

  if [[ -n "${SIGNING_IDENTITY}" ]]; then
    codesign \
      --force \
      --sign "${SIGNING_IDENTITY}" \
      --entitlements "${ENTITLEMENTS_FILE}" \
      --options runtime \
      "${ROOT_DIR}/Broadify Bridge Meeting Helper.app"
  else
    codesign \
      --force \
      --sign - \
      --entitlements "${ENTITLEMENTS_FILE}" \
      "${ROOT_DIR}/Broadify Bridge Meeting Helper.app"
  fi
  codesign --verify --strict --deep --verbose=2 "${ROOT_DIR}/Broadify Bridge Meeting Helper.app"

  if [[ -f "${ROOT_DIR}/Broadify Bridge Meeting Helper.app/Contents/MacOS/BroadifyMeetingHelper" ]]; then
    cp -f "${ROOT_DIR}/Broadify Bridge Meeting Helper.app/Contents/MacOS/BroadifyMeetingHelper" "${ROOT_DIR}/meeting-helper"
    chmod u+w "${ROOT_DIR}/meeting-helper"
  fi
elif [[ -f "${BUILD_DIR}/meeting-helper" ]]; then
  cp -f "${BUILD_DIR}/meeting-helper" "${ROOT_DIR}/meeting-helper"
  chmod u+w "${ROOT_DIR}/meeting-helper"
fi

ONNXRUNTIME_ROOT="${BROADIFY_ONNXRUNTIME_ROOT:-${ROOT_DIR}/deps/onnxruntime/macos-arm64}"
if [[ "${MEETING_HELPER_ENABLE_MODNET:-1}" == "1" ]]; then
  if [[ -f "${ONNXRUNTIME_ROOT}/lib/libonnxruntime.dylib" ]]; then
    cp -f "${ONNXRUNTIME_ROOT}/lib/libonnxruntime.dylib" "${ROOT_DIR}/libonnxruntime.dylib"
    cp -f "${ONNXRUNTIME_ROOT}/lib/libonnxruntime.dylib" "${ROOT_DIR}/libonnxruntime.1.dylib"
    chmod u+w "${ROOT_DIR}/libonnxruntime.dylib"
    chmod u+w "${ROOT_DIR}/libonnxruntime.1.dylib"
  elif [[ -f "${ONNXRUNTIME_ROOT}/libonnxruntime.dylib" ]]; then
    cp -f "${ONNXRUNTIME_ROOT}/libonnxruntime.dylib" "${ROOT_DIR}/libonnxruntime.dylib"
    cp -f "${ONNXRUNTIME_ROOT}/libonnxruntime.dylib" "${ROOT_DIR}/libonnxruntime.1.dylib"
    chmod u+w "${ROOT_DIR}/libonnxruntime.dylib"
    chmod u+w "${ROOT_DIR}/libonnxruntime.1.dylib"
  else
    echo "ONNX Runtime dylib not found under ${ONNXRUNTIME_ROOT}" >&2
    exit 1
  fi
fi

if [[ "$(uname -s)" == "Darwin" ]]; then
  echo "Built ${ROOT_DIR}/Broadify Bridge Meeting Helper.app"
else
  echo "Built ${ROOT_DIR}/meeting-helper"
fi
