# FrameBus Dev Setup (macOS)

**Ziel**
FrameBus im Development zuverlässig starten, ohne Production-Builds.

**Voraussetzungen**
- Node >= 22
- Xcode Command Line Tools
- Python 3 (das Projekt nutzt `node-gyp` >= 10; `scripts/build-framebus.sh` wählt
  automatisch eine kompatible Python-Version, analog zu CI mit Python 3.11)

**Hinweis zu Homebrew/Python**
- Ein `brew upgrade` kann `python3` auf 3.12+ setzen. Das Build-Skript umgeht das
  lokal per Fallback (`/usr/bin/python3` oder `python@3.11`).
- Override nur bei Bedarf: `PYTHON=/pfad/zu/python3 npm run dev`

**Einmalig**
- Native Addon bauen (für aktuelle Electron-Version):
```bash
npm run build:framebus
```
Alternativ manuell:
```bash
cd apps/bridge/native/framebus
npx node-gyp rebuild
```

**Bei Änderungen an Renderer oder Output-Helper**
- Renderer neu bauen:
```bash
npm --prefix apps/bridge run build:graphics-renderer
```
- Output-Helper neu bauen:
```bash
npm --prefix apps/bridge run build
```

**Umgebungsvariablen (Beispiel)**
```bash
BRIDGE_GRAPHICS_RENDERER_SINGLE=1
BRIDGE_FRAMEBUS_NAME=broadify-framebus-dev
BRIDGE_FRAMEBUS_FORCE_RECREATE=1
```
FrameBus wird immer genutzt (keine Flags).

**Display Native Helper bauen** (für Display Output)
```bash
cd apps/bridge/native/display-helper
./build.sh
```
Voraussetzung: `brew install sdl2`

**Optional**
- Falls das Addon an einem anderen Ort liegt:
```bash
BRIDGE_FRAMEBUS_NATIVE_PATH=/Users/dennisschaible/Desktop/Coding/broadify-bridge-v2/apps/bridge/native/framebus/build/Release/framebus.node
```

**Start**
- Tray/Frontend starten:
```bash
npm run dev
```
- Bridge starten:
```bash
npm --prefix apps/bridge run dev
```

**Git**
- Build-Artefakte nicht committen.
- Beispiele: `dist/`, `dist-electron/`, `apps/bridge/native/framebus/build/`.
