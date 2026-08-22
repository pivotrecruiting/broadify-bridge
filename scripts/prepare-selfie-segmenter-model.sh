#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODELS_DIR="$ROOT_DIR/apps/bridge/native/meeting-helper/models"
DEFAULT_TFLITE_URL="https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter_landscape/float16/latest/selfie_segmenter_landscape.tflite"
TFLITE_URL="${SELFIE_SEGMENTER_TFLITE_URL:-$DEFAULT_TFLITE_URL}"
TASK_PATH="${SELFIE_SEGMENTER_TASK_PATH:-$MODELS_DIR/selfie_segmenter_landscape.tflite}"
ONNX_PATH="$MODELS_DIR/selfie_landscape.onnx"
EXPECTED_SHA256="${SELFIE_SEGMENTER_TFLITE_SHA256:-}"

if [[ ! -f "$TASK_PATH" ]]; then
  mkdir -p "$MODELS_DIR"
  echo "Downloading MediaPipe Selfie Segmenter landscape model from: $TFLITE_URL"
  curl -fsSL --retry 5 --retry-delay 15 --retry-all-errors "$TFLITE_URL" \
    -o "$TASK_PATH"
fi

mkdir -p "$MODELS_DIR"

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  else
    shasum -a 256 "$1" | awk '{ print $1 }'
  fi
}

if [[ -n "$EXPECTED_SHA256" ]]; then
  ACTUAL_SHA256="$(hash_file "$TASK_PATH")"
  if [[ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]]; then
    echo "Selfie Segmenter source SHA256 mismatch." >&2
    echo "Expected: $EXPECTED_SHA256" >&2
    echo "Actual:   $ACTUAL_SHA256" >&2
    exit 1
  fi
fi

cat >&2 <<EOF
Conversion command:
  python -m tf2onnx.convert --tflite "$TASK_PATH" --opset 17 --output "$ONNX_PATH"

If tf2onnx cannot read the .task container directly, extract the embedded
TFLite model first and pass that .tflite path to the same command.
EOF

python -m tf2onnx.convert \
  --tflite "$TASK_PATH" \
  --opset 17 \
  --output "$ONNX_PATH"

hash_file "$ONNX_PATH"
