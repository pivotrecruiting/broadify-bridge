# Display Helper Deploy

## Ziel

Build und Deployment des Display Helper Binaries für macOS (arm64, x64). Der Helper wird bei `BRIDGE_DISPLAY_NATIVE_HELPER=1` statt des Electron Display Helpers gestartet.

## Voraussetzungen

- macOS Build-Maschine
- clang++
- SDL2 (`brew install sdl2`)
- Kein proprietäres SDK (im Gegensatz zum DeckLink Helper)

## Ablauf (arm64)

### 1) Build

```bash
cd apps/bridge/native/display-helper
./build.sh
```

### 2) Binary für Architektur kennzeichnen (optional)

```bash
mv display-helper display-helper-arm64
```

### 3) SHA256 erzeugen

```bash
shasum -a 256 display-helper-arm64
```

### 4) Code-Signing (Release / CI)

Für Notarization muss das Binary signiert sein. Manuell oder via Script:

```bash
# Manuell
codesign --force --sign "Developer ID Application: <Team>" display-helper

# Oder: Script (wird von build-display-helper.sh automatisch aufgerufen)
APPLE_SIGNING_IDENTITY="Developer ID Application: <Team>" ./scripts/sign-display-helper.sh
```

### 5) electron-builder Integration

Damit der Helper in der gepackten App enthalten ist, `electron-builder.json` erweitern:

```json
"extraResources": [
  {"from": "apps/bridge/native/decklink-helper/decklink-helper", "to": "native/decklink-helper/decklink-helper"},
  {"from": "apps/bridge/native/display-helper/display-helper", "to": "native/display-helper/display-helper"}
]
```

Die Pfad-Auflösung in `display-helper.ts` nutzt:
- Dev: `apps/bridge/native/display-helper/display-helper`
- Prod: `${process.resourcesPath}/native/display-helper/display-helper`

## x64 Build

Auf einem x86_64 Mac denselben Ablauf ausführen:

```bash
./build.sh
mv display-helper display-helper-x64
shasum -a 256 display-helper-x64
```

## Optional: GitHub Release + Download

Analog zum DeckLink Helper können Display Helper Binaries als Release Assets bereitgestellt werden. Dafür wären erforderlich:

- Scripts: `scripts/build-display-helper.sh`, `scripts/download-display-helper.sh`, `scripts/check-display-helper.sh`
- Secrets: `DISPLAY_HELPER_URL_ARM64`, `DISPLAY_HELPER_SHA256_ARM64`, analog für x64
- `package.json` dist-Scripts: `build:display-helper` vor `electron-builder` ausführen

Bis dahin: Lokaler Build und manuelles Kopieren oder Einbinden in die Build-Pipeline.

## Hinweise

- SDL2 ist die einzige externe Abhängigkeit; kein proprietäres SDK.
- Für Notarization (macOS) muss das Binary signiert sein.
- Binary-Pfad muss fix bleiben; Override nur via `BRIDGE_DISPLAY_HELPER_PATH`.
- Build-Artefakte (`display-helper`) sind in `.gitignore`; nicht committen.
