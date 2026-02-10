# FrameBus Dev Setup (macOS)

**Ziel**
FrameBus im Development zuverlässig starten, ohne Production-Builds.

**Voraussetzungen**
- Node >= 22
- Xcode Command Line Tools
- `python3`

**Einmalig**
- Native Addon bauen:
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
BRIDGE_GRAPHICS_FRAMEBUS=1
BRIDGE_GRAPHICS_OUTPUT_HELPER_FRAMEBUS=1
BRIDGE_FRAMEBUS_NAME=broadify-framebus-dev
BRIDGE_FRAMEBUS_FORCE_RECREATE=1
```

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
