#!/usr/bin/env bash
# Builds the PGM helper (macOS: signed app bundle "Broadify Bridge PGM Helper.app").
# Mirrors meeting-helper/build.sh: Developer ID when available, otherwise a
# stable local identity so the camera (TCC) grant survives rebuilds, otherwise ad-hoc.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="${ROOT_DIR}/build"

cmake -S "${ROOT_DIR}" -B "${BUILD_DIR}" \
  -DCMAKE_BUILD_TYPE="${CMAKE_BUILD_TYPE:-Release}" \
  -DCMAKE_POLICY_VERSION_MINIMUM=3.5 ${PGM_HELPER_CMAKE_EXTRA_ARGS:-}
cmake --build "${BUILD_DIR}" --config "${CMAKE_BUILD_TYPE:-Release}" --target pgm-helper
if [[ "${PGM_HELPER_BUILD_TESTS:-1}" == "1" ]]; then
  cmake --build "${BUILD_DIR}" --config "${CMAKE_BUILD_TYPE:-Release}"
  ctest --test-dir "${BUILD_DIR}" --build-config "${CMAKE_BUILD_TYPE:-Release}" --timeout 120 --output-on-failure
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "pgm-helper: non-macOS builds ship in a later phase." >&2
  exit 0
fi

APP_SOURCE=""
for candidate in "${BUILD_DIR}/BroadifyPgmHelper.app" "${BUILD_DIR}/pgm-helper.app" "${BUILD_DIR}/Release/BroadifyPgmHelper.app"; do
  if [[ -d "${candidate}" ]]; then
    APP_SOURCE="${candidate}"
    break
  fi
done
[[ -n "${APP_SOURCE}" ]] || { echo "PGM helper app bundle not found under ${BUILD_DIR}" >&2; exit 1; }

APP_OUT="${ROOT_DIR}/Broadify Bridge PGM Helper.app"
rm -rf "${APP_OUT}"
cp -R "${APP_SOURCE}" "${APP_OUT}"
chmod -R u+w "${APP_OUT}"

SIGNING_IDENTITY="${PGM_HELPER_SIGNING_IDENTITY:-${MEETING_HELPER_SIGNING_IDENTITY:-}}"
if [[ -z "${SIGNING_IDENTITY}" ]]; then
  SIGNING_IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\(Developer ID Application:.*(PG38DC5RG9)\)"/\1/p' | head -n 1)"
fi
if [[ -z "${SIGNING_IDENTITY}" ]]; then
  SIGNING_IDENTITY="$(security find-identity -p codesigning 2>/dev/null | grep -oE '"(Broadify Dev Signing|Apple Development: [^"]*)"' | tr -d '"' | head -n 1)"
fi
ENTITLEMENTS_FILE="${ROOT_DIR}/macos/BroadifyPgmHelper.entitlements"

sign_adhoc() {
  codesign --force --sign - --entitlements "${ENTITLEMENTS_FILE}" "${APP_OUT}"
}
if [[ -n "${SIGNING_IDENTITY}" ]]; then
  TIMESTAMP_ARGS=()
  [[ "${SIGNING_IDENTITY}" == Developer\ ID\ Application:* ]] && TIMESTAMP_ARGS=(--timestamp)
  if ! SIGN_OUTPUT="$(codesign --force --sign "${SIGNING_IDENTITY}" --entitlements "${ENTITLEMENTS_FILE}" --options runtime "${TIMESTAMP_ARGS[@]}" "${APP_OUT}" 2>&1)"; then
    if [[ "${SIGN_OUTPUT}" == *"A timestamp was expected but was not found."* ]]; then
      echo "Developer ID signing had no timestamp; re-signing PGM helper ad-hoc for local verification." >&2
      sign_adhoc
    else
      echo "${SIGN_OUTPUT}" >&2
      exit 1
    fi
  fi
else
  sign_adhoc
fi
codesign --verify --strict --deep --verbose=2 "${APP_OUT}"
cp -f "${APP_OUT}/Contents/MacOS/BroadifyPgmHelper" "${ROOT_DIR}/pgm-helper"
chmod u+w "${ROOT_DIR}/pgm-helper"
echo "pgm-helper built: ${APP_OUT}"
