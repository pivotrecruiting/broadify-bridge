#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODELS_DIR="$ROOT_DIR/apps/bridge/native/meeting-helper/models"
TASK_PATH="${SELFIE_SEGMENTER_TASK_PATH:-$MODELS_DIR/selfie_segmenter_landscape.task}"
ONNX_PATH="$MODELS_DIR/selfie_landscape.onnx"

if [[ ! -f "$TASK_PATH" ]]; then
  cat >&2 <<EOF
MediaPipe Selfie Segmenter landscape task not found:
  $TASK_PATH

Download the official Apache-2.0 landscape task, then run:
  SELFIE_SEGMENTER_TASK_PATH=/path/to/selfie_segmenter_landscape.task $0
EOF
  exit 1
fi

mkdir -p "$MODELS_DIR"

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

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$ONNX_PATH"
else
  shasum -a 256 "$ONNX_PATH"
fi
