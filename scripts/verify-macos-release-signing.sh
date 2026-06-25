#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXPECTED_ARCH=""
UPDATER_CHANNEL="${BROADIFY_UPDATER_CHANNEL:-latest}"
APP_PRODUCT_NAME="Broadify Bridge"
APP_BUNDLE_ID="com.broadify.bridge"
HELPER_BUNDLE_ID="com.broadify.bridge.meeting-helper"
HELPER_APP_REL="Contents/Resources/native/meeting-helper/Broadify Bridge Meeting Helper.app"
HELPER_EXEC_REL="${HELPER_APP_REL}/Contents/MacOS/BroadifyMeetingHelper"
PRESENTATION_RUNTIME_REL="Contents/Resources/presentation-runtime/macos-arm64/LibreOffice.app"
PRESENTATION_RUNTIME_EXEC_REL="${PRESENTATION_RUNTIME_REL}/Contents/MacOS/soffice"

if [[ "$UPDATER_CHANNEL" == "rc" ]]; then
  APP_PRODUCT_NAME="Broadify Bridge RC"
  APP_BUNDLE_ID="com.broadify.bridge.rc"
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --arch)
      EXPECTED_ARCH="${2:-}"
      shift 2
      ;;
    *)
      echo "[MacSignVerify] Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[MacSignVerify] macOS is required" >&2
  exit 1
fi

if [[ -z "$EXPECTED_ARCH" ]]; then
  EXPECTED_ARCH="$(uname -m)"
fi

normalize_arch() {
  case "$1" in
    arm64 | aarch64)
      echo "arm64"
      ;;
    x64 | x86_64 | amd64)
      echo "x64"
      ;;
    *)
      echo "$1"
      ;;
  esac
}

find_app() {
  local normalized_arch="$1"
  local candidates=(
    "${ROOT_DIR}/dist/mac-${normalized_arch}/${APP_PRODUCT_NAME}.app"
    "${ROOT_DIR}/dist/mac/${APP_PRODUCT_NAME}.app"
  )

  for candidate in "${candidates[@]}"; do
    if [[ -d "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  find "${ROOT_DIR}/dist" -maxdepth 3 -type d -name "${APP_PRODUCT_NAME}.app" -print -quit
}

plist_value() {
  local plist="$1"
  local key="$2"
  /usr/libexec/PlistBuddy -c "Print :${key}" "$plist"
}

require_plist_value() {
  local plist="$1"
  local key="$2"
  local expected="$3"
  local actual
  actual="$(plist_value "$plist" "$key")"
  if [[ "$actual" != "$expected" ]]; then
    echo "[MacSignVerify] ${plist} ${key} expected '${expected}', got '${actual}'" >&2
    exit 1
  fi
  echo "[MacSignVerify] ${key} -> ${actual}"
}

verify_codesign() {
  local target="$1"
  local deep_flag="$2"
  local -a cmd=(codesign --verify --strict --verbose=4)
  if [[ "$deep_flag" == "deep" ]]; then
    cmd+=(--deep)
  fi
  cmd+=("$target")
  "${cmd[@]}"
  echo "[MacSignVerify] codesign verify ok -> ${target}"
}

require_valid_entitlements() {
  local target="$1"
  local output
  local plist
  if ! output="$(codesign -d --entitlements :- "$target" 2>&1)"; then
    echo "$output" >&2
    echo "[MacSignVerify] Could not read entitlements for ${target}" >&2
    exit 1
  fi
  if printf '%s\n' "$output" | grep -qi "invalid entitlements"; then
    echo "$output" >&2
    echo "[MacSignVerify] Invalid entitlements for ${target}" >&2
    exit 1
  fi
  plist="$(printf '%s\n' "$output" | sed -n '/^<?xml/,$p')"
  if [[ -z "$plist" ]]; then
    echo "$output" >&2
    echo "[MacSignVerify] Missing XML entitlements plist for ${target}" >&2
    exit 1
  fi
  if ! printf '%s\n' "$plist" | plutil -lint - >/dev/null; then
    echo "$output" >&2
    echo "[MacSignVerify] Entitlements are not valid plist XML for ${target}" >&2
    exit 1
  fi
  echo "[MacSignVerify] entitlements plist ok -> ${target}"
}

require_entitlement_key() {
  local target="$1"
  local key="$2"
  local output
  local plist
  local tmp_plist
  if ! output="$(codesign -d --entitlements :- "$target" 2>&1)"; then
    echo "$output" >&2
    echo "[MacSignVerify] Could not read entitlements for ${target}" >&2
    exit 1
  fi
  plist="$(printf '%s\n' "$output" | sed -n '/^<?xml/,$p')"
  tmp_plist="$(mktemp)"
  printf '%s\n' "$plist" >"$tmp_plist"
  if ! /usr/libexec/PlistBuddy -c "Print :${key}" "$tmp_plist" >/dev/null 2>&1; then
    rm -f "$tmp_plist"
    echo "$output" >&2
    echo "[MacSignVerify] Missing entitlement ${key} for ${target}" >&2
    exit 1
  fi
  rm -f "$tmp_plist"
  echo "[MacSignVerify] entitlement ${key} present -> ${target}"
}

team_id() {
  codesign -dv --verbose=4 "$1" 2>&1 | awk -F= '/TeamIdentifier=/ { print $2; exit }'
}

NORMALIZED_ARCH="$(normalize_arch "$EXPECTED_ARCH")"
APP_PATH="$(find_app "$NORMALIZED_ARCH")"

if [[ -z "$APP_PATH" || ! -d "$APP_PATH" ]]; then
  echo "[MacSignVerify] Could not find packaged ${APP_PRODUCT_NAME}.app under dist/" >&2
  exit 1
fi

HELPER_APP_PATH="${APP_PATH}/${HELPER_APP_REL}"
HELPER_EXEC_PATH="${APP_PATH}/${HELPER_EXEC_REL}"
PRESENTATION_RUNTIME_PATH="${APP_PATH}/${PRESENTATION_RUNTIME_REL}"
PRESENTATION_RUNTIME_EXEC_PATH="${APP_PATH}/${PRESENTATION_RUNTIME_EXEC_REL}"
APP_INFO="${APP_PATH}/Contents/Info.plist"
HELPER_INFO="${HELPER_APP_PATH}/Contents/Info.plist"

echo "[MacSignVerify] Verifying ${APP_PATH}"

[[ -d "$HELPER_APP_PATH" ]] || {
  echo "[MacSignVerify] Missing Meeting Helper app at ${HELPER_APP_PATH}" >&2
  exit 1
}
[[ -x "$HELPER_EXEC_PATH" ]] || {
  echo "[MacSignVerify] Missing executable Meeting Helper at ${HELPER_EXEC_PATH}" >&2
  exit 1
}
if [[ "$NORMALIZED_ARCH" == "arm64" ]]; then
  [[ -d "$PRESENTATION_RUNTIME_PATH" ]] || {
    echo "[MacSignVerify] Missing bundled presentation runtime at ${PRESENTATION_RUNTIME_PATH}" >&2
    exit 1
  }
  [[ -x "$PRESENTATION_RUNTIME_EXEC_PATH" ]] || {
    echo "[MacSignVerify] Missing bundled LibreOffice executable at ${PRESENTATION_RUNTIME_EXEC_PATH}" >&2
    exit 1
  }
fi

require_plist_value "$APP_INFO" "CFBundleIdentifier" "$APP_BUNDLE_ID"
if ! plist_value "$APP_INFO" "NSLocalNetworkUsageDescription" >/dev/null; then
  echo "[MacSignVerify] App is missing NSLocalNetworkUsageDescription" >&2
  exit 1
fi
echo "[MacSignVerify] NSLocalNetworkUsageDescription present"
require_plist_value "$HELPER_INFO" "CFBundleIdentifier" "$HELPER_BUNDLE_ID"
require_plist_value "$HELPER_INFO" "CFBundleExecutable" "BroadifyMeetingHelper"
require_plist_value "$HELPER_INFO" "CFBundleDisplayName" "Broadify Meeting"
require_plist_value "$HELPER_INFO" "CFBundleName" "Broadify Meeting"
if ! plist_value "$HELPER_INFO" "NSCameraUsageDescription" >/dev/null; then
  echo "[MacSignVerify] Meeting Helper is missing NSCameraUsageDescription" >&2
  exit 1
fi
echo "[MacSignVerify] NSCameraUsageDescription present"

verify_codesign "$HELPER_APP_PATH" "deep"
verify_codesign "$HELPER_EXEC_PATH" "nodeep"
if [[ "$NORMALIZED_ARCH" == "arm64" ]]; then
  verify_codesign "$PRESENTATION_RUNTIME_PATH" "deep"
  verify_codesign "$PRESENTATION_RUNTIME_EXEC_PATH" "nodeep"
fi
verify_codesign "$APP_PATH" "deep"

require_valid_entitlements "$HELPER_EXEC_PATH"
require_valid_entitlements "$APP_PATH"
require_entitlement_key "$APP_PATH" "com.apple.security.network.client"
require_entitlement_key "$APP_PATH" "com.apple.security.network.server"
require_entitlement_key "$HELPER_EXEC_PATH" "com.apple.security.device.camera"

APP_TEAM_ID="$(team_id "$APP_PATH")"
HELPER_TEAM_ID="$(team_id "$HELPER_EXEC_PATH")"
if [[ -z "$APP_TEAM_ID" || "$APP_TEAM_ID" != "$HELPER_TEAM_ID" ]]; then
  echo "[MacSignVerify] Team ID mismatch: app=${APP_TEAM_ID:-none} helper=${HELPER_TEAM_ID:-none}" >&2
  exit 1
fi
echo "[MacSignVerify] Team ID -> ${APP_TEAM_ID}"

spctl -a -t exec -vv "$APP_PATH"
echo "[MacSignVerify] spctl accepted app"

xcrun stapler validate "$APP_PATH"
echo "[MacSignVerify] stapler validate ok -> ${APP_PATH}"

DMG_PATH="$(find "${ROOT_DIR}/dist" -maxdepth 1 -type f \( -name "Broadify-Bridge-*-${NORMALIZED_ARCH}.dmg" -o -name "Broadify-Bridge-RC-*-${NORMALIZED_ARCH}.dmg" \) -print -quit)"
if [[ -n "$DMG_PATH" ]]; then
  if xcrun stapler validate "$DMG_PATH"; then
    echo "[MacSignVerify] stapler validate ok -> ${DMG_PATH}"
  else
    echo "[MacSignVerify] DMG is notarized for online Gatekeeper checks but has no stapled ticket." >&2
    echo "[MacSignVerify] Not stapling here because electron-builder already generated .blockmap/update metadata for this DMG." >&2
  fi
else
  echo "[MacSignVerify] No arch-specific DMG found for stapler validation; skipping DMG stapler check"
fi

echo "[MacSignVerify] macOS release signing verification completed"
