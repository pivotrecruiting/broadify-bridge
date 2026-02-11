#!/usr/bin/env bash
set -euo pipefail

if [[ "${SKIP_FRAMEBUS_BUILD:-}" == "1" ]]; then
  echo "Skipping FrameBus addon build (SKIP_FRAMEBUS_BUILD=1)."
  exit 0
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRAMEBUS_DIR="$ROOT_DIR/apps/bridge/native/framebus"

# Get Electron version from installed package
cd "$ROOT_DIR"
ELECTRON_VERSION=$(node -p "require('electron/package.json').version")
ARCH="${npm_config_arch:-$(node -p "process.arch")}"

echo "[FrameBus] Building addon for Electron $ELECTRON_VERSION (arch: $ARCH)"

cd "$FRAMEBUS_DIR"
npx node-gyp configure \
  --target="$ELECTRON_VERSION" \
  --arch="$ARCH" \
  --dist-url=https://electronjs.org/headers
npx node-gyp build

echo "[FrameBus] Addon built: build/Release/framebus.node"
