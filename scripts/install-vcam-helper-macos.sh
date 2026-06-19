#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_APP="${ROOT_DIR}/apps/bridge/native/vcam-helper/build/Release/BroadifyVCam.app"
DEST_APP="${BRIDGE_VCAM_INSTALL_PATH:-/Applications/BroadifyVCam.app}"
VCAM_DIR="${ROOT_DIR}/apps/bridge/native/vcam-helper"
VCAM_EXTENSION_BUNDLE_ID="${VCAM_EXTENSION_BUNDLE_ID:-com.broadify.vcam.extension}"
VCAM_EXTENSION_BUNDLE_NAME="${VCAM_EXTENSION_BUNDLE_ID}.systemextension"
APP_ENTITLEMENTS="${VCAM_DIR}/BroadifyVCam/BroadifyVCam.entitlements"
EXT_BUNDLE="${SOURCE_APP}/Contents/Library/SystemExtensions/${VCAM_EXTENSION_BUNDLE_NAME}"
LEGACY_EXT_BUNDLE="${SOURCE_APP}/Contents/Library/SystemExtensions/BroadifyVCamExtension.systemextension"
EXT_ENTITLEMENTS="${VCAM_DIR}/BroadifyVCamExtension/BroadifyVCamExtension.entitlements"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "install-vcam-helper-macos: skipping on non-macOS host"
  exit 0
fi

if [[ "${BRIDGE_SKIP_VCAM_INSTALL:-0}" == "1" ]]; then
  echo "install-vcam-helper-macos: skipped via BRIDGE_SKIP_VCAM_INSTALL=1"
  exit 0
fi

bash "${ROOT_DIR}/scripts/build-vcam-helper-macos.sh"

if [[ ! -d "$SOURCE_APP" ]]; then
  echo "install-vcam-helper-macos: missing build artifact at $SOURCE_APP" >&2
  exit 1
fi

if [[ ! -f "$APP_ENTITLEMENTS" ]]; then
  echo "install-vcam-helper-macos: missing app entitlements at $APP_ENTITLEMENTS" >&2
  exit 1
fi

if [[ ! -d "$EXT_BUNDLE" ]]; then
  if [[ -d "$LEGACY_EXT_BUNDLE" ]]; then
    echo "install-vcam-helper-macos: build artifact still contains legacy embedded extension path ${LEGACY_EXT_BUNDLE}" >&2
    echo "install-vcam-helper-macos: rebuild the VCam helper so the extension bundle is renamed and re-signed before installation." >&2
  fi
  echo "install-vcam-helper-macos: missing embedded extension at $EXT_BUNDLE" >&2
  exit 1
fi

if [[ ! -f "$EXT_ENTITLEMENTS" ]]; then
  echo "install-vcam-helper-macos: missing extension entitlements at $EXT_ENTITLEMENTS" >&2
  exit 1
fi

extract_code_sign_team_id() {
  local target="$1"
  codesign -dv --verbose=4 "$target" 2>&1 | awk -F= '/TeamIdentifier=/ { print $2; exit }'
}

extract_profile_team_id() {
  local profile="$1"
  security cms -D -i "$profile" 2>/dev/null | awk '
    /<key>TeamIdentifier<\/key>/ { in_team=1; next }
    in_team && /<string>/ {
      gsub(/.*<string>|<\/string>.*/, "", $0);
      print;
      exit
    }
  '
}

APP_TEAM_ID="$(extract_code_sign_team_id "$SOURCE_APP")"
PROFILE_TEAM_ID="$(extract_profile_team_id "${SOURCE_APP}/Contents/embedded.provisionprofile")"
EXT_TEAM_ID="$(extract_code_sign_team_id "$EXT_BUNDLE")"

if [[ -z "$APP_TEAM_ID" || -z "$PROFILE_TEAM_ID" ]]; then
  echo "install-vcam-helper-macos: could not resolve team identifiers from the built app or provisioning profile" >&2
  exit 1
fi

if [[ "$APP_TEAM_ID" != "$PROFILE_TEAM_ID" ]]; then
  echo "install-vcam-helper-macos: team identifier mismatch for BroadifyVCam.app (codesign=$APP_TEAM_ID, profile=$PROFILE_TEAM_ID)" >&2
  echo "install-vcam-helper-macos: regenerate the Xcode project and rebuild with the same Apple Developer team on both targets." >&2
  exit 1
fi

if [[ -z "$EXT_TEAM_ID" ]]; then
  echo "install-vcam-helper-macos: could not resolve team identifier for BroadifyVCamExtension" >&2
  exit 1
fi

if [[ "$EXT_TEAM_ID" != "$APP_TEAM_ID" ]]; then
  echo "install-vcam-helper-macos: team identifier mismatch between app and extension (app=$APP_TEAM_ID, extension=$EXT_TEAM_ID)" >&2
  echo "install-vcam-helper-macos: both targets must be signed by the same Apple Developer team." >&2
  exit 1
fi

codesign --verify --strict --deep --verbose=2 "${SOURCE_APP}"
codesign --verify --strict --deep --verbose=2 "${EXT_BUNDLE}"

DEST_EXT="${DEST_APP}/Contents/Library/SystemExtensions/${VCAM_EXTENSION_BUNDLE_NAME}"
DEST_EXT_INFO="${DEST_EXT}/Contents/Info.plist"
SOURCE_EXT_INFO="${EXT_BUNDLE}/Contents/Info.plist"

plist_value() {
  /usr/libexec/PlistBuddy -c "Print :$2" "$1" 2>/dev/null || true
}

active_vcam_extension_version() {
  systemextensionsctl list 2>/dev/null \
    | grep 'com.broadify.vcam.extension' \
    | grep '\[activated enabled\]' \
    | sed -n 's/.*com\.broadify\.vcam\.extension ([^/]*\/\([^)]*\)).*/\1/p' \
    | head -n 1 \
    || true
}

avfoundation_lists_vcam() {
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
  if device.localizedName == "broadify Camera" {
    exit(0)
  }
}
exit(1)
' 2>/dev/null
}

SOURCE_EXT_VERSION="$(plist_value "$SOURCE_EXT_INFO" "CFBundleVersion")"

if [[ -d "$DEST_EXT" && -n "$SOURCE_EXT_VERSION" ]]; then
  EXISTING_EXT_VERSION="$(plist_value "$DEST_EXT_INFO" "CFBundleVersion")"
  ACTIVE_EXT_VERSION="$(active_vcam_extension_version)"
  if [[ "$EXISTING_EXT_VERSION" == "$SOURCE_EXT_VERSION" && "$ACTIVE_EXT_VERSION" == "$SOURCE_EXT_VERSION" ]]; then
    if avfoundation_lists_vcam; then
      echo "install-vcam-helper-macos: BroadifyVCamExtension version ${SOURCE_EXT_VERSION} is already installed, active, and visible to AVFoundation"
      echo "install-vcam-helper-macos: leaving ${DEST_APP} unchanged"
      exit 0
    fi

    echo "install-vcam-helper-macos: BroadifyVCamExtension version ${SOURCE_EXT_VERSION} is already installed and active, but AVFoundation does not list broadify Camera" >&2
    echo "install-vcam-helper-macos: leaving ${DEST_APP} unchanged to avoid creating another macOS SystemExtension snapshot" >&2
    echo "install-vcam-helper-macos: open ${DEST_APP}, click Activate extension, then run npm run verify:vcam-helper" >&2
    exit 1
  fi
fi

echo "Installing BroadifyVCam.app to ${DEST_APP}"
rm -rf "$DEST_APP"
ditto "$SOURCE_APP" "$DEST_APP"
xattr -dr com.apple.quarantine "$DEST_APP" 2>/dev/null || true

if [[ ! -d "$DEST_EXT" ]]; then
  echo "install-vcam-helper-macos: installed app is missing embedded system extension at ${DEST_EXT}" >&2
  exit 1
fi

codesign --verify --strict --deep --verbose=2 "${DEST_APP}"
codesign --verify --strict --verbose=2 "${DEST_EXT}"

INSTALLED_EXT_VERSION="$(plist_value "$DEST_EXT_INFO" "CFBundleVersion")"

echo "install-vcam-helper-macos: canonical helper app is ${DEST_APP}"
echo "install-vcam-helper-macos: always launch this copy (not Xcode DerivedData builds)."

if command -v systemextensionsctl >/dev/null 2>&1; then
  if systemextensionsctl list 2>/dev/null | grep -q "com.broadify.vcam.extension"; then
    echo "install-vcam-helper-macos: BroadifyVCamExtension is listed by systemextensionsctl"
  else
    echo "install-vcam-helper-macos: BroadifyVCamExtension is installed but not activated yet. Open the app and approve it in System Settings." >&2
  fi
fi

echo "Installed ${DEST_APP}"

wait_for_active_vcam_extension_version() {
  local expected_version="$1"
  local active_version=""
  for _ in {1..20}; do
    active_version="$(active_vcam_extension_version)"
    if [[ "$active_version" == "$expected_version" ]]; then
      echo "$active_version"
      return 0
    fi
    sleep 1
  done
  active_vcam_extension_version
}

if [[ "${BRIDGE_VCAM_REINITIALIZE_ON_INSTALL:-1}" == "1" ]]; then
  if command -v systemextensionsctl >/dev/null 2>&1 && [[ -n "$INSTALLED_EXT_VERSION" ]]; then
    ACTIVE_EXT_VERSION="$(wait_for_active_vcam_extension_version "$INSTALLED_EXT_VERSION")"
    if [[ "$ACTIVE_EXT_VERSION" == "$INSTALLED_EXT_VERSION" ]]; then
      echo "install-vcam-helper-macos: active BroadifyVCamExtension version is ${ACTIVE_EXT_VERSION}"
    else
      echo "install-vcam-helper-macos: opening BroadifyVCam.app to request extension activation"
      /usr/bin/osascript -e 'tell application id "com.broadify.vcam" to quit' >/dev/null 2>&1 || true
      /usr/bin/pkill -x BroadifyVCam >/dev/null 2>&1 || true
      /usr/bin/open "$DEST_APP"
      ACTIVE_EXT_VERSION="$(wait_for_active_vcam_extension_version "$INSTALLED_EXT_VERSION")"
    fi

    if [[ "$ACTIVE_EXT_VERSION" != "$INSTALLED_EXT_VERSION" ]]; then
      echo "install-vcam-helper-macos: BroadifyVCamExtension installed version is ${INSTALLED_EXT_VERSION}, active version is ${ACTIVE_EXT_VERSION:-none}" >&2
      echo "install-vcam-helper-macos: click Activate extension in ${DEST_APP} and approve the replacement in System Settings." >&2
    fi
  else
    echo "install-vcam-helper-macos: opening BroadifyVCam.app to request extension activation"
    /usr/bin/osascript -e 'tell application id "com.broadify.vcam" to quit' >/dev/null 2>&1 || true
    /usr/bin/pkill -x BroadifyVCam >/dev/null 2>&1 || true
    /usr/bin/open "$DEST_APP"
  fi
fi

if command -v systemextensionsctl >/dev/null 2>&1; then
  RUNNING_EXT="$(systemextensionsctl list 2>/dev/null | grep 'com.broadify.vcam.extension' || true)"
  if [[ -n "$RUNNING_EXT" ]]; then
    echo ""
    echo "IMPORTANT: macOS keeps the previously activated system extension running from"
    echo "/Library/SystemExtensions/ until you replace it. After each VCam rebuild:"
    echo "  1. open \"${DEST_APP}\""
    echo "  2. Click \"Activate extension\" and approve the replacement if macOS asks"
    echo "  3. Verify: npm run verify:vcam-helper"
  fi
fi
