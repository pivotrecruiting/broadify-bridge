#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODELS_DIR="$ROOT_DIR/apps/bridge/native/meeting-helper/models"
TARGET="$MODELS_DIR/MODNet.mlpackage"
MANIFEST="$MODELS_DIR/coreml-manifest.json"
SOURCE="${MODNET_COREML_MODEL_SOURCE:-}"
TEMP_DIR=""

cleanup() {
  if [[ -n "$TEMP_DIR" && -d "$TEMP_DIR" ]]; then
    rm -rf "$TEMP_DIR"
  fi
}
trap cleanup EXIT

if [[ ! -d "$TARGET" ]]; then
  if [[ -n "$SOURCE" ]]; then
    if [[ -d "$SOURCE/MODNet.mlpackage" ]]; then
      SOURCE="$SOURCE/MODNet.mlpackage"
    fi
    if [[ ! -d "$SOURCE" ]]; then
      echo "MODNET_COREML_MODEL_SOURCE does not contain MODNet.mlpackage." >&2
      exit 1
    fi
    cp -R "$SOURCE" "$TARGET"
  elif [[ -n "${MODNET_COREML_MODEL_URL:-}" ]]; then
    TEMP_DIR="$(mktemp -d)"
    curl -fsSL "$MODNET_COREML_MODEL_URL" -o "$TEMP_DIR/model.zip"
    ditto -x -k "$TEMP_DIR/model.zip" "$TEMP_DIR/extracted"
    SOURCE="$(find "$TEMP_DIR/extracted" -type d -name MODNet.mlpackage -print -quit)"
    if [[ -z "$SOURCE" ]]; then
      echo "Downloaded archive does not contain MODNet.mlpackage." >&2
      exit 1
    fi
    cp -R "$SOURCE" "$TARGET"
  else
    echo "MODNet.mlpackage is missing. Set MODNET_COREML_MODEL_SOURCE or MODNET_COREML_MODEL_URL." >&2
    exit 1
  fi
fi

node - "$MANIFEST" "$TARGET" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const [manifestPath, packagePath] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
for (const file of manifest.files) {
  const filePath = path.join(packagePath, ...file.path.split("/"));
  if (!fs.existsSync(filePath)) {
    throw new Error(`CoreML model file missing: ${file.path}`);
  }
  const actual = crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  if (actual !== file.sha256) {
    throw new Error(`CoreML model hash mismatch: ${file.path}`);
  }
}
NODE

echo "Prepared and verified $TARGET"
