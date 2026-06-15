#!/usr/bin/env bash
set -euo pipefail

if [[ "${SKIP_FRAMEBUS_BUILD:-}" == "1" ]]; then
  echo "Skipping FrameBus addon build (SKIP_FRAMEBUS_BUILD=1)."
  exit 0
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRAMEBUS_DIR="$ROOT_DIR/apps/bridge/native/framebus"
NODE_GYP_BIN="$ROOT_DIR/node_modules/.bin/node-gyp"

# Prefer a Python build that node-gyp can use. Homebrew may point python3 at 3.12+
# while older node-gyp releases still import distutils (removed in Python 3.12).
# CI pins Python 3.11 explicitly; local dev mirrors that fallback chain.
resolve_python_for_node_gyp() {
  if [[ -n "${PYTHON:-}" ]]; then
    echo "[FrameBus] Using PYTHON from environment: $PYTHON"
    return 0
  fi

  local candidates=(
    "/opt/homebrew/opt/python@3.11/bin/python3"
    "/opt/homebrew/opt/python@3.12/bin/python3"
    "/usr/local/opt/python@3.11/bin/python3"
    "/usr/bin/python3"
    "/Applications/Xcode.app/Contents/Developer/usr/bin/python3"
  )

  local candidate
  for candidate in "${candidates[@]}"; do
    if [[ -x "$candidate" ]] && "$candidate" -c "import distutils" >/dev/null 2>&1; then
      export PYTHON="$candidate"
      echo "[FrameBus] Using Python $("$candidate" --version 2>&1) ($candidate)"
      return 0
    fi
  done

  echo "[FrameBus] WARNING: No Python with distutils found; node-gyp will auto-detect." >&2
  echo "[FrameBus] If configure fails, set PYTHON=/usr/bin/python3 or install python@3.11 via Homebrew." >&2
}

# Get Electron version from installed package
cd "$ROOT_DIR"
ELECTRON_VERSION=$(node -p "require('electron/package.json').version")
ARCH="${npm_config_arch:-$(node -p "process.arch")}"

if [[ ! -x "$NODE_GYP_BIN" ]]; then
  echo "[FrameBus] ERROR: node-gyp not found at $NODE_GYP_BIN. Run npm install first." >&2
  exit 1
fi

resolve_python_for_node_gyp

echo "[FrameBus] Building addon for Electron $ELECTRON_VERSION (arch: $ARCH)"
echo "[FrameBus] Using node-gyp $("$NODE_GYP_BIN" --version)"

cd "$FRAMEBUS_DIR"
"$NODE_GYP_BIN" configure \
  --target="$ELECTRON_VERSION" \
  --arch="$ARCH" \
  --dist-url=https://electronjs.org/headers
"$NODE_GYP_BIN" build

echo "[FrameBus] Addon built: build/Release/framebus.node"
