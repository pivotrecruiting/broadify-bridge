# Build-Prozess Dokumentation

## Übersicht

Dieses Dokument beschreibt den vollständigen Build-Prozess für die Broadify Bridge, inklusive FFmpeg-Kompilierung und Lizenz-Compliance.

## Build-Abhängigkeiten

### Erforderliche Tools

- **Node.js:** >= 22.12
- **npm:** Latest
- **TypeScript:** ~5.7.2
- **Build-Tools:** (für FFmpeg-Kompilierung)
  - **macOS:** Xcode Command Line Tools
  - **Linux:** build-essential, make, gcc
  - **Windows:** Visual Studio Build Tools

### Erforderliche SDKs

- **Blackmagic Desktop Video SDK:** Für DeckLink-Support
  - Download: https://www.blackmagicdesign.com/support/family/desktop-video-sdk
  - Installation: Siehe Blackmagic Design Dokumentation

## Build-Schritte

### 1. Dependencies installieren

```bash
# Root-Dependencies
npm install

# Bridge-Dependencies
cd apps/bridge
npm install
cd ../..
```

### 2. FFmpeg Setup

**Wichtig:** FFmpeg ist **optional für den Build**. Der Build schlägt nicht fehl, wenn FFmpeg-Assets nicht verfügbar sind. Für Production muss FFmpeg jedoch verfügbar sein (entweder gebundelt oder manuell platziert).

#### Option A: Automatischer Download (BtbN FFmpeg Builds)

```bash
npm run download:ffmpeg
```

**Funktionalität:**

- Lädt BtbN FFmpeg Builds von GitHub Releases
- Für mac-arm64: Fallback auf Martin Riedl Builds (https://evermeet.cx/ffmpeg/)
- Wenn Assets nicht verfügbar: Warnung, aber Build wird fortgesetzt
- Speichert in `resources/ffmpeg/<platform>/`

**Hinweis:** BtbN Builds haben möglicherweise keinen DeckLink-Support. Für SDI-Output wird Blackmagic FFmpeg benötigt.

#### Option B: Blackmagic FFmpeg (für SDI + NDI)

**Manuell:**

1. FFmpeg mit DeckLink-Support kompilieren (siehe `docs/ffmpeg-setup.md`)
2. Binary in `resources/ffmpeg/<platform>/ffmpeg` platzieren

**Automatisiert (geplant):**

```bash
npm run build:ffmpeg:decklink
```

#### Option C: Alternative Quellen

**Für mac-arm64:**

- **Martin Riedl Builds:** Automatisch als Fallback verwendet, wenn BtbN Asset nicht verfügbar ist
- **URL:** https://evermeet.cx/ffmpeg/
- **Hinweis:** Diese Builds haben möglicherweise keinen DeckLink-Support

### 3. TypeScript kompilieren

```bash
# Electron Main/Preload
npm run transpile:electron

# Bridge
npm run build:bridge

# Graphics Renderer
npm run build:graphics-renderer
```

### 4. React App bauen

```bash
npm run build:app
```

### 5. Electron App packen

```bash
# macOS (ARM64)
npm run dist:mac:arm64

# macOS (x64)
npm run dist:mac:x64

# Windows
npm run dist:win

# Linux
npm run dist:linux

# Alle Plattformen
npm run dist:all
```

## FFmpeg Build-Prozess

### Minimal-Build (Lizenz-optimiert)

**Ziel:** FFmpeg nur mit DeckLink, ohne GPL/nonfree

```bash
# 1. FFmpeg Source Code klonen
git clone https://git.ffmpeg.org/ffmpeg.git ffmpeg-source
cd ffmpeg-source

# 2. Konfigurieren (OHNE --enable-gpl und --enable-nonfree)
./configure \
  --enable-decklink \
  --extra-cflags="-I/PATH/TO/DECKLINK/SDK/include" \
  --extra-ldflags="-L/PATH/TO/DECKLINK/SDK/lib"

# 3. Kompilieren
make -j$(nproc)

# 4. Binary extrahieren
cp ffmpeg ../resources/ffmpeg/<platform>/ffmpeg
chmod +x ../resources/ffmpeg/<platform>/ffmpeg
```

**Test:**

```bash
./ffmpeg -f decklink -list_devices 1 -i dummy
```

### GPL-Build (falls Minimal-Build nicht funktioniert)

**Warnung:** GPL erfordert Quellcode-Bereitstellung!

```bash
# 1. FFmpeg Source Code klonen
git clone https://git.ffmpeg.org/ffmpeg.git ffmpeg-source
cd ffmpeg-source

# 2. Konfigurieren (MIT --enable-gpl)
./configure \
  --enable-gpl \
  --enable-decklink \
  --extra-cflags="-I/PATH/TO/DECKLINK/SDK/include" \
  --extra-ldflags="-L/PATH/TO/DECKLINK/SDK/lib"

# 3. Kompilieren
make -j$(nproc)

# 4. Binary extrahieren
cp ffmpeg ../resources/ffmpeg/<platform>/ffmpeg
chmod +x ../resources/ffmpeg/<platform>/ffmpeg

# 5. Build-Informationen dokumentieren
echo "FFmpeg Build Information:" > ../docs/ffmpeg-build-info.txt
echo "Git Commit: $(git rev-parse HEAD)" >> ../docs/ffmpeg-build-info.txt
echo "Configure: --enable-gpl --enable-decklink ..." >> ../docs/ffmpeg-build-info.txt
./ffmpeg -version >> ../docs/ffmpeg-build-info.txt
```

**GPL-Compliance:**

- ✅ Quellcode bereitstellen (Git Repository)
- ✅ Build-Skripte dokumentieren
- ✅ Konfiguration dokumentieren
- ✅ GPL-Lizenztext in App

## Build-Skripte

### `scripts/download-ffmpeg.js`

Lädt FFmpeg Builds für alle Plattformen mit robustem Fallback-Mechanismus.

**Verwendung:**

```bash
npm run download:ffmpeg
```

**Funktionalität:**

- Prüft ob Blackmagic FFmpeg vorhanden (manuell platziert)
- Falls nicht: Lädt BtbN Builds von GitHub Releases
- **Fallback für mac-arm64:** Martin Riedl Builds (https://evermeet.cx/ffmpeg/)
- **Graceful Handling:** Wenn Assets nicht verfügbar sind, wird eine Warnung ausgegeben, aber der Build wird fortgesetzt
- Speichert in `resources/ffmpeg/<platform>/`

**Verhalten bei fehlenden Assets:**

- Gibt Warnung aus, aber beendet mit Exit Code 0 (Erfolg)
- Build kann fortgesetzt werden
- Für Production: FFmpeg muss manuell platziert werden (siehe `docs/ffmpeg-setup.md`)

### `scripts/build-ffmpeg-decklink.js` (geplant)

Kompiliert FFmpeg mit DeckLink-Support.

**Verwendung:**

```bash
npm run build:ffmpeg:decklink
```

**Funktionalität:**

- Prüft ob DeckLink SDK vorhanden
- Klont/aktualisiert FFmpeg Source Code
- Konfiguriert mit DeckLink-Support
- Kompiliert für aktuelle Plattform
- Kopiert Binary nach `resources/ffmpeg/`

### `scripts/check-ffmpeg.js`

Prüft FFmpeg-Setup für alle Plattformen.

**Verwendung:**

```bash
npm run check:ffmpeg
```

**Funktionalität:**

- Prüft ob FFmpeg vorhanden
- Testet DeckLink-Support
- Gibt Status für alle Plattformen aus
- **Robust:** Gibt Warnung aus, wenn FFmpeg fehlt, aber beendet mit Exit Code 0 (Erfolg)
- Build kann fortgesetzt werden, auch wenn FFmpeg fehlt

## Build-Konfiguration

### `electron-builder.json`

Definiert Electron-Builder Konfiguration.

**Wichtig:**

- `extraResources` enthält `resources/ffmpeg/` → wird mit App gebundelt
- FFmpeg-Binaries werden in `process.resourcesPath/ffmpeg/` verfügbar sein

### `package.json`

Definiert Build-Scripts.

**Wichtig:**

- `dist:*` Scripts rufen `download:ffmpeg` und `check:ffmpeg` auf
- FFmpeg wird vor dem Build heruntergeladen/geprüft
- **Robust:** Build schlägt nicht fehl, wenn FFmpeg-Download fehlschlägt
- Warnungen werden ausgegeben, aber Build wird fortgesetzt
- Für Production: Stelle sicher, dass FFmpeg verfügbar ist (entweder gebundelt oder manuell platziert)

## Lizenz-Compliance während Build

### Automatische Checks

**Geplant:**

- FFmpeg-Lizenz-Status prüfen
- SDK-Lizenzen prüfen
- Lizenzhinweise generieren

### Manuelle Checks

**Vor jedem Release:**

- [ ] FFmpeg Build-Konfiguration dokumentiert
- [ ] GPL-Quellcode bereitgestellt (falls GPL aktiviert)
- [ ] Lizenzhinweise aktualisiert
- [ ] NOTICES.md aktualisiert

## Troubleshooting

### Problem: FFmpeg nicht gefunden

**Lösung:**

1. Prüfe ob `npm run download:ffmpeg` ausgeführt wurde
2. Prüfe ob FFmpeg in `resources/ffmpeg/<platform>/` vorhanden ist
3. Prüfe `FFMPEG_PATH` Environment Variable
4. **Hinweis:** Fehlende FFmpeg-Assets blockieren den Build nicht mehr. Der Build wird mit Warnung fortgesetzt.
5. **Für Production:** Stelle sicher, dass FFmpeg verfügbar ist (siehe `docs/ffmpeg-setup.md`)

### Problem: mac-arm64 Asset nicht verfügbar

**Lösung:**

1. Das Script versucht automatisch Martin Riedl Builds als Fallback
2. Falls auch das fehlschlägt: Manuell Blackmagic FFmpeg platzieren (siehe `docs/ffmpeg-setup.md`)
3. Build wird mit Warnung fortgesetzt

### Problem: DeckLink-Support fehlt

**Lösung:**

1. Prüfe ob Blackmagic FFmpeg in `resources/ffmpeg/` platziert ist
2. Prüfe ob FFmpeg DeckLink-Support hat: `ffmpeg -formats | grep decklink`
3. Falls nicht: FFmpeg mit `--enable-decklink` neu kompilieren

### Problem: Build schlägt fehl

**Lösung:**

1. Prüfe Node.js Version: `node --version` (>= 22.12)
2. Prüfe Dependencies: `npm install`
3. Prüfe TypeScript: `npm run transpile:electron`
4. Prüfe Logs für Fehlermeldungen

## Nächste Schritte

1. ⏳ `build-ffmpeg-decklink.js` Script erstellen
2. ⏳ Automatische Lizenz-Checks implementieren
3. ⏳ CI/CD Integration für automatische Builds
