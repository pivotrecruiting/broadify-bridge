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

FFMPEG_PATH="resources/ffmpeg/$PLATFORM_DIR/ffmpeg"

echo "Selected platform: $PLATFORM"
echo "FFmpeg path: $FFMPEG_PATH"
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

# Step 2: Ensure FFmpeg
echo ""
echo "Step 2: Ensure FFmpeg..."
if command -v ffmpeg &> /dev/null; then
  echo "✓ FFmpeg found at: $(which ffmpeg)"
  mkdir -p "resources/ffmpeg/$PLATFORM_DIR"
  cp "$(which ffmpeg)" "$FFMPEG_PATH"
  chmod +x "$FFMPEG_PATH"
  echo "✓ FFmpeg copied to $FFMPEG_PATH"
else
  echo "⚠ FFmpeg not found in PATH, trying ffmpeg-static..."
  cd apps/bridge
  if node scripts/copy-ffmpeg-static.js; then
    echo "✓ FFmpeg copied from ffmpeg-static"
  else
    echo "ERROR: Could not get FFmpeg"
    exit 1
  fi
  cd ../..
fi

# Step 3: Validate FFmpeg
echo ""
echo "Step 3: Validate FFmpeg..."
if [ -f "$FFMPEG_PATH" ]; then
  echo "File type:"
  file "$FFMPEG_PATH" || true
  echo "File permissions:"
  ls -la "$FFMPEG_PATH" || true
  echo "Testing FFmpeg execution:"
  "$FFMPEG_PATH" -version | head -n 1
  echo "✓ FFmpeg validation successful"
else
  echo "ERROR: FFmpeg not found at $FFMPEG_PATH"
  exit 1
fi

# Step 4: Build Bridge
echo ""
echo "Step 4: Build Bridge..."
cd apps/bridge
npm run build
cd ../..

# Step 5: Transpile Electron
echo ""
echo "Step 5: Transpile Electron..."
npm run transpile:electron

# Step 6: Build React
echo ""
echo "Step 6: Build React..."
npm run build:app

# Step 7: Download FFmpeg (simulating download:ffmpeg script)
echo ""
echo "Step 7: Run download:ffmpeg script..."
npm run download:ffmpeg || echo "⚠ Download script had warnings (expected if FFmpeg already exists)"

# Step 8: Verify FFmpeg still present
echo ""
echo "Step 8: Verify FFmpeg still present..."
if [ -f "$FFMPEG_PATH" ]; then
  "$FFMPEG_PATH" -version | head -n 1
  echo "✓ FFmpeg still present"
else
  echo "ERROR: FFmpeg missing after download script"
  exit 1
fi

# Step 9: Final validation
echo ""
echo "Step 9: Final validation..."
if [ ! -x "$FFMPEG_PATH" ]; then
  echo "Making FFmpeg executable..."
  chmod +x "$FFMPEG_PATH"
fi
"$FFMPEG_PATH" -version | head -n 1
echo "✓ Final validation successful"

echo ""
echo "=== All workflow steps completed successfully! ==="
echo ""
echo "To actually build the Electron app, run:"
echo "  npm run $DIST_SCRIPT -- --publish=never"
echo ""
echo "Or test on GitHub Actions:"
echo "  1. Push to 'test-release' branch, or"
echo "  2. Go to Actions → 'Test Release Build' → 'Run workflow'"

