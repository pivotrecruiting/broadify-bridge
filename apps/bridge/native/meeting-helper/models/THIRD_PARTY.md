# Meeting Helper Model Attribution

## MediaPipe Selfie Segmenter Landscape

- Component: MediaPipe Selfie Segmenter landscape model, converted to ONNX as
  `selfie_landscape.onnx`.
- License: Apache License 2.0.
- Source: Google MediaPipe model assets.
- Repository policy: the converted binary model is not committed. Release/CI
  downloads or prepares it into `apps/bridge/native/meeting-helper/models`.

Conversion command:

```bash
SELFIE_SEGMENTER_TASK_PATH=/path/to/selfie_segmenter_landscape.task \
  bash scripts/prepare-selfie-segmenter-model.sh
```

The script runs:

```bash
python -m tf2onnx.convert \
  --tflite /path/to/selfie_segmenter_landscape.task \
  --opset 17 \
  --output apps/bridge/native/meeting-helper/models/selfie_landscape.onnx
```

If the converter cannot read the `.task` container directly, extract the
embedded `.tflite` file and pass that path as `SELFIE_SEGMENTER_TASK_PATH`.
