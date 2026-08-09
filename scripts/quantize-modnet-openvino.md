# MODNet INT8 Quantization for the OpenVINO Backend (offline tooling)

Produces `models/modnet-ov-int8.xml/.bin` from `models/modnet.onnx` via NNCF
post-training quantization. The OpenVINO matting backend
(`src/keyer/openvino_keyer.cpp`) prefers this IR over the FP32 ONNX when the
manifest declares it AND both files hash-verify; otherwise it silently keeps
the ONNX path. INT8 mainly pays off on NPUs and older Intel iGPUs (roughly
2x over FP16-ish execution).

This is developer tooling: it is **never** run in CI or at build/package time.

## Recipe

1. Install the tooling (Python 3.10+):

   ```bash
   pip install openvino==2025.4.* nncf pillow numpy
   ```

2. Collect calibration frames: 100-300 representative camera frames
   (presenter in front of the camera, varied lighting/backgrounds, the real
   1280x720-ish aspect) as PNG/JPG in one folder. A fifth of the frames is
   held out for validation.

3. Quantize + validate:

   ```bash
   python3 scripts/quantize-modnet-openvino.py \
     --onnx apps/bridge/native/meeting-helper/models/modnet.onnx \
     --calibration-dir /path/to/frames \
     --output-dir apps/bridge/native/meeting-helper/models
   ```

## Acceptance criterion

The script computes the mean absolute alpha error of the INT8 model against
the FP32 baseline on the held-out frames (CPU inference, identical MODNet
preprocessing as `matting_common.cpp`). The IR is only acceptable when

```
alpha MAE (INT8 vs FP32) <= 0.01
```

The script exits non-zero above the limit; do not ship such an IR (more or
better calibration frames usually fix it).

## Wiring the result

The script prints a ready-made `models/manifest.json` entry:

```json
{
  "name": "modnet-ov-int8",
  "file": "modnet-ov-int8.xml",
  "sha256": "<xml sha256>",
  "bin_file": "modnet-ov-int8.bin",
  "bin_sha256": "<bin sha256>",
  "required": false
}
```

Append it to `models[]`. The helper is tolerant when the entry or the files
are absent (`required: false`); when present, BOTH hashes must verify or the
backend falls back to the ONNX model. To package the IR, also add both files
to the Windows `models` extraResources filter in `electron-builder.config.cjs`.
