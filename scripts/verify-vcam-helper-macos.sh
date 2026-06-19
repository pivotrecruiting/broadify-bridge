#!/usr/bin/env bash
set -euo pipefail

DEST_APP="${BRIDGE_VCAM_INSTALL_PATH:-/Applications/BroadifyVCam.app}"
VCAM_EXTENSION_BUNDLE_ID="${VCAM_EXTENSION_BUNDLE_ID:-com.broadify.vcam.extension}"
VCAM_DEVICE_NAME="${VCAM_DEVICE_NAME:-broadify Camera}"
VCAM_EXTENSION_BUNDLE_NAME="${VCAM_EXTENSION_BUNDLE_ID}.systemextension"
DEST_EXT="${DEST_APP}/Contents/Library/SystemExtensions/${VCAM_EXTENSION_BUNDLE_NAME}"
DEST_EXT_INFO="${DEST_EXT}/Contents/Info.plist"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "verify-vcam-helper-macos: skipping on non-macOS host"
  exit 0
fi

fail() {
  echo "verify-vcam-helper-macos: $1" >&2
  echo "" >&2
  echo "Recovery:" >&2
  echo "  1. Quit duplicate BroadifyVCam.app instances if more than one is open." >&2
  echo "  2. Open \"${DEST_APP}\"." >&2
  echo "  3. Click \"Activate extension\" and approve the replacement if macOS asks." >&2
  echo "  4. If old Broadify versions show \"waiting to uninstall on reboot\", reboot macOS." >&2
  echo "  5. Re-run: npm run verify:vcam-helper" >&2
  exit 1
}

plist_value() {
  /usr/libexec/PlistBuddy -c "Print :$2" "$1" 2>/dev/null || true
}

active_vcam_extension_version() {
  systemextensionsctl list 2>/dev/null \
    | grep "${VCAM_EXTENSION_BUNDLE_ID}" \
    | grep '\[activated enabled\]' \
    | sed -n "s/.*${VCAM_EXTENSION_BUNDLE_ID//./\\.} ([^/]*\/\([^)]*\)).*/\1/p" \
    | head -n 1 \
    || true
}

system_extension_status() {
  systemextensionsctl list 2>/dev/null | grep "${VCAM_EXTENSION_BUNDLE_ID}" || true
}

pending_uninstall_count() {
  systemextensionsctl list 2>/dev/null \
    | grep "${VCAM_EXTENSION_BUNDLE_ID}" \
    | grep -c 'waiting to uninstall on reboot' \
    || true
}

running_vcam_app_count() {
  /usr/bin/pgrep -x BroadifyVCam 2>/dev/null | wc -l | tr -d ' '
}

avfoundation_camera_list() {
  /usr/bin/swift -e '
import AVFoundation

let types: [AVCaptureDevice.DeviceType] = [
  .builtInWideAngleCamera,
  .external
]
let session = AVCaptureDevice.DiscoverySession(
  deviceTypes: types,
  mediaType: .video,
  position: .unspecified
)

for device in session.devices {
  print("\(device.localizedName)|\(device.uniqueID)|\(device.deviceType.rawValue)")
}
' 2>/dev/null
}

wait_for_avfoundation_camera() {
  local camera_list=""
  for _ in {1..10}; do
    camera_list="$(avfoundation_camera_list)"
    if grep -Fq "${VCAM_DEVICE_NAME}|" <<<"$camera_list"; then
      echo "$camera_list"
      return 0
    fi
    sleep 1
  done
  echo "$camera_list"
}

if [[ ! -d "$DEST_APP" ]]; then
  fail "missing installed VCam app at ${DEST_APP}"
fi

if [[ ! -d "$DEST_EXT" ]]; then
  fail "missing embedded system extension at ${DEST_EXT}"
fi

if ! command -v systemextensionsctl >/dev/null 2>&1; then
  fail "systemextensionsctl is unavailable"
fi

APP_VERSION="$(plist_value "${DEST_APP}/Contents/Info.plist" "CFBundleVersion")"
INSTALLED_EXT_VERSION="$(plist_value "$DEST_EXT_INFO" "CFBundleVersion")"

if [[ -z "$APP_VERSION" ]]; then
  fail "could not read CFBundleVersion from ${DEST_APP}"
fi

if [[ -z "$INSTALLED_EXT_VERSION" ]]; then
  fail "could not read CFBundleVersion from ${DEST_EXT_INFO}"
fi

if [[ "$APP_VERSION" != "$INSTALLED_EXT_VERSION" ]]; then
  fail "app version ${APP_VERSION} does not match embedded extension version ${INSTALLED_EXT_VERSION}"
fi

ACTIVE_EXT_VERSION="$(active_vcam_extension_version)"
if [[ "$ACTIVE_EXT_VERSION" != "$INSTALLED_EXT_VERSION" ]]; then
  echo "verify-vcam-helper-macos: system extension status:" >&2
  system_extension_status >&2
  fail "installed extension version is ${INSTALLED_EXT_VERSION}, but active version is ${ACTIVE_EXT_VERSION:-none}"
fi

CAMERA_LIST="$(wait_for_avfoundation_camera)"
if ! grep -Fq "${VCAM_DEVICE_NAME}|" <<<"$CAMERA_LIST"; then
  echo "verify-vcam-helper-macos: AVFoundation cameras:" >&2
  if [[ -n "$CAMERA_LIST" ]]; then
    echo "$CAMERA_LIST" >&2
  else
    echo "  none" >&2
  fi
  RUNNING_VCAM_APP_COUNT="$(running_vcam_app_count)"
  if [[ "$RUNNING_VCAM_APP_COUNT" != "0" ]]; then
    echo "verify-vcam-helper-macos: running BroadifyVCam.app instance(s): ${RUNNING_VCAM_APP_COUNT}" >&2
  fi
  fail "AVFoundation does not list ${VCAM_DEVICE_NAME}"
fi

PENDING_UNINSTALL_COUNT="$(pending_uninstall_count)"
if [[ "$PENDING_UNINSTALL_COUNT" != "0" ]]; then
  echo "verify-vcam-helper-macos: ${PENDING_UNINSTALL_COUNT} old BroadifyVCam extension version(s) are waiting to uninstall on reboot"
  echo "verify-vcam-helper-macos: macOS owns /Library/SystemExtensions cleanup; reboot to remove stale extension snapshots"
fi

echo "verify-vcam-helper-macos: active ${VCAM_EXTENSION_BUNDLE_ID} version ${ACTIVE_EXT_VERSION}"
echo "verify-vcam-helper-macos: AVFoundation lists ${VCAM_DEVICE_NAME}"
