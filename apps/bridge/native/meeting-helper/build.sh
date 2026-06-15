#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="${ROOT_DIR}/build"

cmake -S "${ROOT_DIR}" -B "${BUILD_DIR}" -DCMAKE_BUILD_TYPE="${CMAKE_BUILD_TYPE:-Release}"
cmake --build "${BUILD_DIR}" --config "${CMAKE_BUILD_TYPE:-Release}"

if [[ -f "${BUILD_DIR}/meeting-helper" ]]; then
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

echo "Built ${ROOT_DIR}/meeting-helper"
