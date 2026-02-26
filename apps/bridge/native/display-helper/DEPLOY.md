# Display Helper Deploy

## Ziel

Build und Deployment des Display Helper Binaries für macOS und Windows. Der Helper wird vom Display Video Output Adapter gestartet (immer, kein Electron-Fallback mehr).

## Voraussetzungen (macOS)

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

Die Plattform-spezifische Einbindung erfolgt über `electron-builder.config.cjs`:
- macOS: `native/display-helper/display-helper`
- Windows: `native/display-helper/display-helper.exe` (optional zusätzlich `SDL2.dll`)

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

## Windows (x64)

### 1) Build (Developer PowerShell / VS Build Tools)

```powershell
cd apps/bridge/native/display-helper
./build.ps1
```

Voraussetzungen:
- `cl.exe` im PATH (Visual Studio Developer Shell)
- SDL2 über `SDL2_DIR` oder `VCPKG_ROOT`

Artefakte:
- `display-helper.exe`
- optional `SDL2.dll` (wird vom Build-Script neben das EXE kopiert, wenn gefunden)

### 2) Packaging

- `npm run dist:win` baut jetzt den Display Helper vor `electron-builder`.
- `electron-builder.config.cjs` nimmt `display-helper.exe` (und optional `SDL2.dll`) in `extraResources` auf.

## Optional: GitHub Release + Download

Analog zum DeckLink Helper können Display Helper Binaries als Release Assets bereitgestellt werden. Dafür wären erforderlich:

- Scripts: `scripts/build-display-helper.sh`, `scripts/download-display-helper.sh`, `scripts/check-display-helper.sh`
- Secrets: `DISPLAY_HELPER_URL_ARM64`, `DISPLAY_HELPER_SHA256_ARM64`, analog für x64
- `package.json` dist-Scripts: `build:display-helper` vor `electron-builder` ausführen

Bis dahin: Lokaler Build und manuelles Kopieren oder Einbinden in die Build-Pipeline.

## Hinweise

- SDL2 ist die einzige externe Abhängigkeit; kein proprietäres SDK.
- Für Notarization (macOS) muss das Binary signiert sein.
- Auf Windows muss `SDL2.dll` zur Laufzeit verfügbar sein (neben `display-helper.exe` oder via PATH).
- Binary-Pfad muss fix bleiben; Override nur via `BRIDGE_DISPLAY_HELPER_PATH`.
- Build-Artefakte (`display-helper`, `display-helper.exe`, `SDL2.dll`) sind in `.gitignore`; nicht committen.
