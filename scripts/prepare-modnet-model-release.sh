#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODELS_DIR="$ROOT_DIR/apps/bridge/native/meeting-helper/models"
SOURCE_MODEL="$MODELS_DIR/modnet.onnx"
RELEASE_FILENAME="${MODNET_MODEL_RELEASE_FILENAME:-modnet.onnx}"
ARTIFACT_PATH="$MODELS_DIR/$RELEASE_FILENAME"

if [[ ! -f "$SOURCE_MODEL" ]]; then
  echo "MODNet model missing at $SOURCE_MODEL" >&2
  echo "Place modnet.onnx in apps/bridge/native/meeting-helper/models/ first." >&2
  exit 1
fi

if [[ "$SOURCE_MODEL" != "$ARTIFACT_PATH" ]]; then
  cp "$SOURCE_MODEL" "$ARTIFACT_PATH"
fi

if command -v sha256sum >/dev/null 2>&1; then
  sha256="$(sha256sum "$ARTIFACT_PATH" | awk '{print $1}')"
else
  sha256="$(shasum -a 256 "$ARTIFACT_PATH" | awk '{print $1}')"
fi

echo "Prepared release asset: $ARTIFACT_PATH"
echo "SHA256: $sha256"
echo ""
echo "Next steps:"
echo "1. Upload $RELEASE_FILENAME to a GitHub Release (separate assets repo recommended)."
echo "2. Set MODNET_MODEL_URL in this repo's GitHub Actions secrets, e.g.:"
echo "   https://github.com/<owner>/<assets-repo>/releases/download/<tag>/$RELEASE_FILENAME"
echo "3. Ensure models/manifest.json sha256 matches: $sha256"
