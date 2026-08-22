# Meeting Helper Model Attribution

## MediaPipe Selfie Segmenter Landscape

- Component: MediaPipe Selfie Segmenter landscape model, converted to ONNX as
  `selfie_landscape.onnx`.
- License: Apache License 2.0.
- Source: Google MediaPipe model assets,
  `https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter_landscape/float16/latest/selfie_segmenter_landscape.tflite`.
- Version: `float16/latest` as published by MediaPipe model storage at
  conversion time.
- Repository policy: the converted binary model is not committed. Release/CI
  downloads or prepares it into `apps/bridge/native/meeting-helper/models`.
- Runtime contract: ONNX input is NHWC `1x144x256x3` float RGB in `[0,1]`;
  output is a single foreground probability/logit mask upsampled by the helper
  to the 512x288 work grid / frame aspect path.

Conversion command:

```bash
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
