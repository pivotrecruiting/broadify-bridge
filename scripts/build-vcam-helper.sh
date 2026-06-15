#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "VCam helper build is macOS-only in V1." >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VCAM_DIR="${ROOT_DIR}/apps/bridge/native/vcam-helper"

if ! command -v xcodegen >/dev/null 2>&1; then
  echo "xcodegen is required (brew install xcodegen)" >&2
  exit 1
fi

cd "${VCAM_DIR}"
xcodegen generate
xcodebuild -project BroadifyVCam.xcodeproj -scheme BroadifyVCam -configuration Release build

echo "VCam helper build finished. Sign and install the extension manually (see README)."
