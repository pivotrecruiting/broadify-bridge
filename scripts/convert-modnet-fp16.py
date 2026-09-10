#!/usr/bin/env python3
"""Convert the fp32 MODNet ONNX model to half precision (fp16).

This produces the `modnet-fp16` artifact that the meeting-helper keyer picks up
when BROADIFY_MEETING_KEYER_FP16=1 is set AND a matching manifest entry exists.
Without this artifact the keyer transparently stays on the fp32 model, so the
conversion is an opt-in performance experiment (roughly 2x DirectML throughput
on capable GPUs), never a silent default change.

The graph inputs and outputs are converted to fp16 as well (keep_io_types=False):
the helper derives its I/O precision from the model's declared input type, so a
fully-fp16 model is what its fp16 code path expects. The mask output is a single
0..1 alpha channel and the input is a normalized image, so fp16's dynamic range
is more than sufficient; the joint-bilateral upsampler downstream hides the
reduced mantissa at the mask edge.

Usage:
    python scripts/convert-modnet-fp16.py \
        --input  apps/bridge/native/meeting-helper/models/modnet.onnx \
        --output apps/bridge/native/meeting-helper/models/modnet_fp16.onnx

It prints the output file's SHA-256 so it can be pinned in the model manifest
(the same `sha256` verification the fp32 model goes through at load time).

Requires: onnx, onnxconverter-common (pip install onnx onnxconverter-common).
"""

import argparse
import hashlib
import sys


def sha256_hex(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description="Convert MODNet ONNX to fp16.")
    parser.add_argument("--input", required=True, help="fp32 modnet.onnx path")
    parser.add_argument("--output", required=True, help="fp16 output .onnx path")
    args = parser.parse_args()

    try:
        import onnx
        from onnxconverter_common import float16
    except ImportError as exc:  # pragma: no cover - environment guard
        print(
            "Missing dependency: pip install onnx onnxconverter-common\n"
            f"({exc})",
            file=sys.stderr,
        )
        return 2

    model = onnx.load(args.input)
    # keep_io_types=False -> inputs and outputs become fp16, matching the
    # helper's model-driven I/O precision detection.
    model_fp16 = float16.convert_float_to_float16(model, keep_io_types=False)
    onnx.save(model_fp16, args.output)

    onnx.checker.check_model(args.output)
    print(f"Wrote {args.output}")
    print(f"sha256: {sha256_hex(args.output)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
