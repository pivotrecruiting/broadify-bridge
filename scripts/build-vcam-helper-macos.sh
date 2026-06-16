#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VCAM_DIR="${ROOT_DIR}/apps/bridge/native/vcam-helper"
VCAM_DEVELOPMENT_TEAM="${VCAM_DEVELOPMENT_TEAM:-PG38DC5RG9}"
VCAM_EXTENSION_BUNDLE_ID="${VCAM_EXTENSION_BUNDLE_ID:-com.broadify.vcam.extension}"
VCAM_EXTENSION_BUNDLE_NAME="${VCAM_EXTENSION_BUNDLE_ID}.systemextension"
VCAM_CMIO_MACH_SERVICE="${VCAM_DEVELOPMENT_TEAM}.com.broadify.vcam.service"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "build-vcam-helper-macos: macOS is required" >&2
  exit 1
fi

if ! command -v xcodegen >/dev/null 2>&1; then
  echo "build-vcam-helper-macos: xcodegen is required (brew install xcodegen)" >&2
  exit 1
fi

if ! command -v xcodebuild >/dev/null 2>&1; then
  echo "build-vcam-helper-macos: xcodebuild is required" >&2
  exit 1
fi

# Pick the signing identity (by prefix) that belongs to the expected team.
# Generic identity names can resolve to a personal team when multiple certs exist.
resolve_signing_identity_for_team() {
  local team_id="$1"
  local identity_prefix="$2"
  local identity=""

  while IFS= read -r line; do
    [[ "$line" == *"\"${identity_prefix}:"* ]] || continue

    local hash=""
    local name=""
    if [[ "$line" =~ \"([^\"]+)\"$ ]]; then
      name="${BASH_REMATCH[1]}"
    fi
    if [[ "$line" =~ \)[[:space:]]+([A-F0-9]{40})[[:space:]]+\" ]]; then
      hash="${BASH_REMATCH[1]}"
    elif [[ "$line" =~ ^[[:space:]]*[0-9]+\)[[:space:]]+([A-F0-9]{40})[[:space:]]+\" ]]; then
      hash="${BASH_REMATCH[1]}"
    fi
    [[ -n "$hash" && -n "$name" ]] || continue

    local cert_team_id=""
    cert_team_id="$(
      security find-certificate -c "$name" -p 2>/dev/null \
        | openssl x509 -noout -subject 2>/dev/null \
        | sed -n 's/.*OU=\([^,/]*\).*/\1/p'
    )"
    if [[ "$cert_team_id" == "$team_id" ]]; then
      identity="$name"
      break
    fi
  done < <(security find-identity -v -p codesigning 2>/dev/null)

  if [[ -z "$identity" ]]; then
    echo "build-vcam-helper-macos: no \"${identity_prefix}\" identity found for team ${team_id}" >&2
    echo "build-vcam-helper-macos: install the matching certificate for team ${team_id} in Keychain Access." >&2
    exit 1
  fi

  echo "$identity"
}

verify_cmio_extension_metadata() {
  local ext_info_plist="$1"

  if ! plutil -extract CMIOExtension.CMIOExtensionMachServiceName raw "${ext_info_plist}" >/dev/null 2>&1; then
    echo "build-vcam-helper-macos: missing CMIOExtensionMachServiceName in ${ext_info_plist}" >&2
    return 1
  fi

  local mach_service=""
  mach_service="$(plutil -extract CMIOExtension.CMIOExtensionMachServiceName raw "${ext_info_plist}")"
  if [[ "${mach_service}" != "${VCAM_CMIO_MACH_SERVICE}" ]]; then
    echo "build-vcam-helper-macos: expected CMIO mach service ${VCAM_CMIO_MACH_SERVICE}, got ${mach_service}" >&2
    return 1
  fi

  return 0
}

# development (default): automatic signing with an Apple Development cert, used
#   for local builds and `npm run install:vcam-helper`.
# developer-id: manual signing with the Developer ID Application cert + the
#   Developer ID provisioning profiles named in project.yml. Used by the release
#   CI to produce a notarizable, distributable system extension. The profiles
#   must be installed under ~/Library/MobileDevice/Provisioning Profiles/.
VCAM_SIGNING_MODE="${VCAM_SIGNING_MODE:-development}"

cd "${VCAM_DIR}"
xcodegen generate

if [[ "${VCAM_SIGNING_MODE}" == "developer-id" ]]; then
  # Validate the Developer ID cert is present for the expected team (the actual
  # per-target profile selection comes from PROVISIONING_PROFILE_SPECIFIER in
  # project.yml).
  CODE_SIGN_IDENTITY="$(resolve_signing_identity_for_team "${VCAM_DEVELOPMENT_TEAM}" "Developer ID Application")"
  echo "build-vcam-helper-macos: Developer ID signing with team ${VCAM_DEVELOPMENT_TEAM} (${CODE_SIGN_IDENTITY})"
  xcodebuild \
    -project BroadifyVCam.xcodeproj \
    -scheme BroadifyVCam \
    -configuration Release \
    -derivedDataPath build \
    SYMROOT=build \
    DEVELOPMENT_TEAM="${VCAM_DEVELOPMENT_TEAM}" \
    CODE_SIGN_STYLE=Manual \
    CODE_SIGN_IDENTITY="Developer ID Application" \
    CODE_SIGN_ALLOW_ENTITLEMENTS_MODIFICATION=YES \
    build
else
  CODE_SIGN_IDENTITY="$(resolve_signing_identity_for_team "${VCAM_DEVELOPMENT_TEAM}" "Apple Development")"
  echo "build-vcam-helper-macos: development signing with team ${VCAM_DEVELOPMENT_TEAM} (${CODE_SIGN_IDENTITY})"
  xcodebuild \
    -project BroadifyVCam.xcodeproj \
    -scheme BroadifyVCam \
    -configuration Release \
    -derivedDataPath build \
    SYMROOT=build \
    DEVELOPMENT_TEAM="${VCAM_DEVELOPMENT_TEAM}" \
    CODE_SIGN_ALLOW_ENTITLEMENTS_MODIFICATION=YES \
    -allowProvisioningUpdates \
    build
fi

APP_PATH="${VCAM_DIR}/build/Release/BroadifyVCam.app"
EXT_PATH="${APP_PATH}/Contents/Library/SystemExtensions/${VCAM_EXTENSION_BUNDLE_NAME}"
LEGACY_EXT_PATH="${APP_PATH}/Contents/Library/SystemExtensions/BroadifyVCamExtension.systemextension"
EXT_INFO_PLIST="${EXT_PATH}/Contents/Info.plist"

if [[ -d "${LEGACY_EXT_PATH}" && ! -d "${EXT_PATH}" ]]; then
  echo "build-vcam-helper-macos: renaming legacy embedded extension bundle to ${VCAM_EXTENSION_BUNDLE_NAME}"
  mv "${LEGACY_EXT_PATH}" "${EXT_PATH}"
fi

if [[ ! -d "${EXT_PATH}" ]]; then
  echo "build-vcam-helper-macos: embedded system extension missing at ${EXT_PATH}" >&2
  echo "build-vcam-helper-macos: verify the Embed System Extensions build phase in project.yml." >&2
  exit 1
fi

if ! verify_cmio_extension_metadata "${EXT_INFO_PLIST}"; then
  exit 1
fi

APP_TEAM_ID="$(codesign -dv --verbose=4 "${APP_PATH}" 2>&1 | awk -F= '/TeamIdentifier=/ { print $2; exit }')"
if [[ "${APP_TEAM_ID}" != "${VCAM_DEVELOPMENT_TEAM}" ]]; then
  echo "build-vcam-helper-macos: expected team ${VCAM_DEVELOPMENT_TEAM}, got ${APP_TEAM_ID}" >&2
  exit 1
fi

echo "BroadifyVCam.app built at ${APP_PATH} (CMIO extension configured)"
