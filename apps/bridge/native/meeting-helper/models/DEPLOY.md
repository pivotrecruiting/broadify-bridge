# MODNet Model Release Asset

The MODNet ONNX model is not stored in git. Windows release builds download it
from a pinned GitHub Release asset URL (`MODNET_MODEL_URL` secret).

Security: CI verifies the downloaded file against `sha256` in `manifest.json`.

## One-time setup

### 1. Obtain `modnet.onnx`

Place the model locally:

```text
apps/bridge/native/meeting-helper/models/modnet.onnx
```

Update `manifest.json` if the hash changed:

```bash
bash scripts/hash-meeting-model.sh modnet.onnx
```

### 2. Prepare the release asset

```bash
npm run prepare:modnet-model-release
```

This prints the SHA256 and the asset path (`modnet.onnx`).

### 3. Upload to GitHub Releases

Recommended: separate assets repo (e.g. `broadify-meeting-models`), same pattern
as DeckLink helper.

1. Open GitHub → assets repo → **Releases** → **Draft a new release**
2. Tag, e.g. `v1.0.0`
3. Upload `modnet.onnx`
4. **Publish release**

### 4. Set secret in the app repo

GitHub → app repo → **Settings** → **Secrets and variables** → **Actions**:

- `MODNET_MODEL_URL` =
  `https://github.com/<owner>/<assets-repo>/releases/download/<tag>/modnet.onnx`

The SHA256 is read from `manifest.json` at build time; no separate hash secret
is required.

### 5. Verify

Run **Test Release Build** (Windows matrix job) or re-run a failed release build.

## Updating the model

1. Replace `modnet.onnx` locally
2. Update `manifest.json` hash (`hash-meeting-model.sh`)
3. Upload new asset to a new release tag
4. Update `MODNET_MODEL_URL` to the new download URL
5. Commit manifest change to the app repo

## macOS Core ML model provenance

`MODNet.mlpackage` (tracked in git) history:

- **2026-10-11 — fine-tune ft-v7d** (introduced by this change, macOS AND Windows):
  replaces ft-v6f, which made head/ear/shoulder edges flicker more in the field.
  Root cause: the own greenscreen labels used by every v6 run marked the black office
  chair behind the shoulders as person (in 6-98 % of the frames per clip), plus a dark
  seam and label noise; the v6f field advantage was a selection bias (picked on the
  same clips it adapted to). ft-v7d = ft-v5d + framed "pictures of people" pasted into
  training backgrounds with alpha 0 (share 0.15 for 3000 iters, then 0.30 for 2000
  iters), NO own labels, NO SOC. Acceptance gate written down before the first
  candidate result (broadify-keyer-training, models/results/gate-20261010/
  GATE-KRITERIEN.md; one tie-break rule was added before the v7c/v7d results; ft-v6f
  fails the gate): out-of-domain VM240K test sequences through the simulated Mac
  chain, head and shoulder edge flicker and band MAD within +/-1.3 % of ft-v5d (raw
  matte shoulder MAD +1.6 %), dark objects behind the person keyed 0.86x, framed
  person picture on the wall keyed 0.71x, benchmark 512 clean 5.7 / webcam 8.8
  (ft-v5d CoreML 6.3 / 9.2). Windows: ONNX export matches the checkpoint within float
  noise (benchmark 5.8 / 8.8); manifest.json sha256 updated here. PENDING before the
  next RC: attach modnet-ft-v7d.onnx to a broadify-bridge release and repoint
  MODNET_MODEL_URL, otherwise the Windows release job stops at the sha256 check.
- **2026-10-05 — fine-tune ft-v6f** (v0.27.3-rc.5): ft-v5d + own chroma-keyed
  greenscreen labels (25 %), SOC adaptation on own webcam frames, framed picture
  distractors. Superseded by ft-v7d after field feedback (edge flicker, see above).
- **2026-09-15 — fine-tune ft-v5d** (macOS AND Windows, v0.27.1-rc.15 .. v0.27.2 and v0.27.3-rc.1 .. rc.4): winner of the
  2026-09-12 autonomous training night (weighted multi-resolution 512/384/320/256
  + SD/HD VideoMatte240K composites + hardened webcam degradation, cooldown
  segments with decaying LR). Benchmark: 512 clean 6.5 / webcam 9.2 (ft-v3: 6.8 /
  9.7); 256 tier ~20% better than ft-v3. Windows: first model update - ONNX
  exported via export_onnx.py (broadify-keyer-training), asset
  modnet-ft-v5d.onnx attached to the broadify-bridge v0.27.1-rc.10 release
  (fallback location: no write access to the broadify-meeting-helper assets repo),
  MODNET_MODEL_URL updated, manifest.json sha256 refreshed.
- **2026-09-10 — fine-tune ft-v3**: continuation of ft-v2 with 12000
  additional iterations and a 5x larger CC0 background pool (1806 views from
  all 301 Poly Haven indoor HDRIs). Internal benchmark: clean MAD 6.6 (was 8.2),
  webcam-degraded MAD 9.7 (was 12.9). Same export pipeline and interface.
- **2026-09-09 — fine-tune ft-v2**: MODNet photographic checkpoint
  fine-tuned on VideoMatte240K train split composited over CC0 backgrounds with
  webcam-style degradation (2000 iters, lr 5e-5, frozen BatchNorm). Exported via
  `scripts/export_coreml.py` in the `broadify-keyer-training` project (input
  "image" 512x512 RGB, output "alpha" GRAYSCALE_FLOAT16, ML Program,
  normalization baked into the image input). Internal benchmark (200 samples,
  VM240K test split): clean MAD 8.2 vs 9.7 before; webcam-degraded MAD 12.9 vs
  40.6 before. Windows `modnet.onnx` intentionally unchanged in this step.
- Before: original MODNet *photographic* portrait matting weights (note: the
  photographic variant, not the webcam variant), converted with coremltools 9.0.

After swapping the package, refresh the three sha256 entries in
`coreml-manifest.json` (hash `Manifest.json`, `model.mlmodel`, `weight.bin`);
`scripts/prepare-modnet-coreml-model.sh` verifies them during dist builds.
