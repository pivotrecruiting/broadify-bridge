#!/bin/bash

# Test Workflow Script - Simuliert GitHub Actions Workflow lokal
# Usage: ./scripts/test-workflow.sh [platform]
# Platform: mac-arm64, mac-x64, linux (default: auto-detect)

set -e

PLATFORM=${1:-auto}
OS=$(uname -s)
ARCH=$(uname -m)

echo "=== Testing Workflow Steps Locally ==="
echo "OS: $OS"
echo "Arch: $ARCH"
echo ""

# Auto-detect platform if not specified
if [[ "$PLATFORM" == "auto" ]]; then
  if [[ "$OS" == "Darwin" ]]; then
    if [[ "$ARCH" == "arm64" ]]; then
      PLATFORM="mac-arm64"
      DIST_SCRIPT="dist:mac:arm64"
    else
      PLATFORM="mac-x64"
      DIST_SCRIPT="dist:mac:x64"
    fi
  elif [[ "$OS" == "Linux" ]]; then
    PLATFORM="linux"
    DIST_SCRIPT="dist:linux"
  else
    echo "ERROR: Unsupported OS: $OS"
    exit 1
  fi
fi

# Set platform-specific variables
case "$PLATFORM" in
  mac-arm64)
    PLATFORM_DIR="mac-arm64"
    DIST_SCRIPT="dist:mac:arm64"
    ;;
  mac-x64)
    PLATFORM_DIR="mac-x64"
    DIST_SCRIPT="dist:mac:x64"
    ;;
  linux)
    PLATFORM_DIR="linux"
    DIST_SCRIPT="dist:linux"
    ;;
  *)
    echo "ERROR: Invalid platform: $PLATFORM"
    echo "Valid platforms: mac-arm64, mac-x64, linux"
    exit 1
    ;;
esac

echo "Selected platform: $PLATFORM"
echo "Dist script: $DIST_SCRIPT"
echo ""

# Step 1: Install dependencies
echo "Step 1: Install root dependencies..."
npm install

echo ""
echo "Step 2: Install Bridge dependencies..."
cd apps/bridge
npm install
cd ../..

# Step 2: Build Bridge
echo ""
echo "Step 4: Build Bridge..."
cd apps/bridge
npm run build
cd ../..

# Step 3: Transpile Electron
echo ""
echo "Step 5: Transpile Electron..."
npm run transpile:electron

# Step 4: Build React
echo ""
echo "Step 6: Build React..."
npm run build:app


echo ""
echo "=== All workflow steps completed successfully! ==="
echo ""
echo "To actually build the Electron app, run:"
echo "  npm run $DIST_SCRIPT -- --publish=never"
echo ""
echo "Or test on GitHub Actions:"
echo "  1. Push to 'test-release' branch, or"
echo "  2. Go to Actions → 'Test Release Build' → 'Run workflow'"

