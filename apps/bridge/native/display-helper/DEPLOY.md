# Display Helper Deploy

## Ziel

Build und Deployment des Display Helper Binaries für macOS und Windows. Der Helper wird vom Display Video Output Adapter gestartet (immer, kein Electron-Fallback mehr).

## Voraussetzungen (macOS)

- macOS Build-Maschine
- clang++
- SDL2 (`brew install sdl2`) oder ein eigener SDL2-Runtime-Pfad via `SDL2_DYLIB_PATH`
- Kein proprietäres SDK (im Gegensatz zum DeckLink Helper)

## Ablauf (arm64)

### 1) Build

```bash
cd apps/bridge/native/display-helper
DISPLAY_HELPER_MACOSX_DEPLOYMENT_TARGET=13.0 ./build.sh
```

Alternativ als gepinntes Release-Bundle vom Repo-Root:

```bash
npm run prepare:sdl2-macos-release
```

Wenn die lokale SDL2-Runtime bereits auf ein neueres `minos` gebaut ist, fuer Release-Builds zusaetzlich strikt pruefen:

```bash
SDL2_STRICT_MINOS=1 DISPLAY_HELPER_MACOSX_DEPLOYMENT_TARGET=13.0 ./build.sh
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
codesign --force --sign "Developer ID Application: <Team>" libSDL2-2.0.0.dylib
codesign --force --sign "Developer ID Application: <Team>" display-helper

# Oder: Script (wird von build-display-helper.sh automatisch aufgerufen)
APPLE_SIGNING_IDENTITY="Developer ID Application: <Team>" ./scripts/sign-display-helper.sh
```

Ohne konfigurierte Identity verwendet das Script lokal automatisch Ad-hoc-Signing, damit der nach `install_name_tool` umgeschriebene SDL2-Bundle-Pfad auf macOS weiterhin ladbar bleibt.

### 5) electron-builder Integration

Die Plattform-spezifische Einbindung erfolgt über `electron-builder.config.cjs`:
- macOS: `native/display-helper/display-helper` + `native/display-helper/libSDL2-2.0.0.dylib`
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
- Für Notarization (macOS) muessen Runtime-Dylib und Binary signiert sein.
- Homebrew-SDL2 von neueren macOS-Versionen kann selbst Ventura-inkompatibel sein. Fuer Release-Builds sollte deshalb ein gepinntes SDL2-Bundle via `SDL2_BUNDLE_DIR` bzw. CI-Download verwendet werden.
- Auf Windows muss `SDL2.dll` zur Laufzeit verfügbar sein (neben `display-helper.exe` oder via PATH).
- Binary-Pfad muss fix bleiben; Override nur via `BRIDGE_DISPLAY_HELPER_PATH`.
- Build-Artefakte (`display-helper`, `libSDL2-2.0.0.dylib`, `display-helper.exe`, `SDL2.dll`) sind in `.gitignore`; nicht committen.
