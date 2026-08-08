#!/usr/bin/env python3
"""Offline NNCF post-training quantization of MODNet to OpenVINO INT8 IR.

Produces models/modnet-ov-int8.xml/.bin from modnet.onnx using a folder of
calibration frames, then validates the quantized model against the FP32
baseline (alpha mean-absolute-error). See scripts/quantize-modnet-openvino.md
for the full recipe, the acceptance criterion (alpha MAE <= 0.01 vs FP32) and
how to wire the result into models/manifest.json.

This script is developer tooling: it is NOT executed in CI or at build time.

Usage:
  python3 scripts/quantize-modnet-openvino.py \
    --onnx apps/bridge/native/meeting-helper/models/modnet.onnx \
    --calibration-dir /path/to/frames \
    --output-dir apps/bridge/native/meeting-helper/models

Requirements (see the .md for pinned install instructions):
  pip install openvino nncf pillow numpy
"""

import argparse
import hashlib
import json
import sys
from pathlib import Path

import numpy as np

try:
    import openvino as ov
    import nncf
except ImportError as error:  # pragma: no cover - dependency guidance
    sys.exit(
        f"Missing dependency: {error}. Install with: pip install openvino nncf pillow numpy"
    )

from PIL import Image

# Calibration/validation input size. 512 is the high_quality inference size;
# the helper reshapes the IR per size at run time, so quantization statistics
# collected at 512 serve every tier.
INPUT_SIZE = 512
# Acceptance criterion: mean absolute alpha error vs the FP32 baseline over
# the validation frames, measured in [0, 1] alpha units.
MAX_ALPHA_MAE = 0.01


def load_frame_tensor(path: Path) -> np.ndarray:
    """RGB image -> NCHW float tensor with the MODNet (v/255-0.5)/0.5 norm.

    Mirrors buildModnetInputTensor in matting_common.cpp (nearest-neighbor
    resize, RGB channel order) so calibration matches production inputs.
    """
    image = Image.open(path).convert("RGB").resize(
        (INPUT_SIZE, INPUT_SIZE), Image.NEAREST
    )
    array = np.asarray(image, dtype=np.float32) / 255.0
    array = (array - 0.5) / 0.5
    return np.expand_dims(array.transpose(2, 0, 1), axis=0)


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--onnx", required=True, type=Path, help="Path to modnet.onnx")
    parser.add_argument(
        "--calibration-dir",
        required=True,
        type=Path,
        help="Folder of representative camera frames (png/jpg); 100-300 frames recommended",
    )
    parser.add_argument(
        "--output-dir",
        required=True,
        type=Path,
        help="Where modnet-ov-int8.xml/.bin are written",
    )
    parser.add_argument(
        "--validation-fraction",
        type=float,
        default=0.2,
        help="Fraction of frames held out for the FP32-vs-INT8 MAE validation",
    )
    args = parser.parse_args()

    frames = sorted(
        [
            p
            for p in args.calibration_dir.iterdir()
            if p.suffix.lower() in {".png", ".jpg", ".jpeg", ".bmp"}
        ]
    )
    if len(frames) < 10:
        sys.exit(
            f"Need at least 10 calibration frames in {args.calibration_dir}, found {len(frames)}"
        )
    holdout = max(1, int(len(frames) * args.validation_fraction))
    validation_frames = frames[:holdout]
    calibration_frames = frames[holdout:]

    print(f"Reading FP32 model: {args.onnx}")
    core = ov.Core()
    model = core.read_model(args.onnx)
    # Static shape: NNCF statistics and the NPU path want a fixed input; the
    # helper reshapes per tier at run time anyway.
    model.reshape([1, 3, INPUT_SIZE, INPUT_SIZE])

    calibration_dataset = nncf.Dataset(calibration_frames, load_frame_tensor)
    print(f"Quantizing with {len(calibration_frames)} calibration frames (NNCF PTQ)...")
    quantized = nncf.quantize(
        model,
        calibration_dataset,
        # Matting quality lives in the decoder's boundary refinement; the
        # default MIXED preset keeps activations signed where needed.
        preset=nncf.QuantizationPreset.MIXED,
        subset_size=min(len(calibration_frames), 300),
    )

    args.output_dir.mkdir(parents=True, exist_ok=True)
    xml_path = args.output_dir / "modnet-ov-int8.xml"
    bin_path = args.output_dir / "modnet-ov-int8.bin"
    ov.save_model(quantized, xml_path, compress_to_fp16=False)
    print(f"Wrote {xml_path} and {bin_path}")

    print(f"Validating alpha MAE on {len(validation_frames)} held-out frames (CPU)...")
    fp32_compiled = core.compile_model(model, "CPU")
    int8_compiled = core.compile_model(core.read_model(xml_path), "CPU")
    errors = []
    for frame in validation_frames:
        tensor = load_frame_tensor(frame)
        fp32_alpha = fp32_compiled(tensor)[fp32_compiled.output(0)]
        int8_alpha = int8_compiled(tensor)[int8_compiled.output(0)]
        errors.append(float(np.mean(np.abs(fp32_alpha - int8_alpha))))
    mae = float(np.mean(errors))
    print(f"alpha MAE (INT8 vs FP32): {mae:.5f} (limit {MAX_ALPHA_MAE})")

    manifest_entry = {
        "name": "modnet-ov-int8",
        "file": xml_path.name,
        "sha256": sha256_of(xml_path),
        "bin_file": bin_path.name,
        "bin_sha256": sha256_of(bin_path),
        "required": False,
    }
    print("manifest.json entry (append to models[]):")
    print(json.dumps(manifest_entry, indent=2))

    if mae > MAX_ALPHA_MAE:
        print(
            "FAILED: quantization degraded the matte beyond the acceptance "
            "criterion; do not ship this IR (try more/better calibration frames)."
        )
        return 1
    print("PASSED: IR meets the acceptance criterion.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
