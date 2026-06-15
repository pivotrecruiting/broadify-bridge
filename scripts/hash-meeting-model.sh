#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <model-filename>" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODEL_PATH="${ROOT_DIR}/apps/bridge/native/meeting-helper/models/$1"

if [[ ! -f "${MODEL_PATH}" ]]; then
  echo "Model not found: ${MODEL_PATH}" >&2
  exit 1
fi

if command -v shasum >/dev/null 2>&1; then
  shasum -a 256 "${MODEL_PATH}"
elif command -v sha256sum >/dev/null 2>&1; then
  sha256sum "${MODEL_PATH}"
else
  echo "No sha256 tool available" >&2
  exit 1
fi
