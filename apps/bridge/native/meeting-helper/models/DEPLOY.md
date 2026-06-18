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
