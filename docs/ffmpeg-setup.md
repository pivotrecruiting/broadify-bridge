# FFmpeg Setup für SDI-Output

## Übersicht

Für SDI-Output (DeckLink) benötigt die Bridge FFmpeg mit DeckLink-Support. Die automatisch heruntergeladenen BtbN FFmpeg-Builds haben möglicherweise **keinen** DeckLink-Support.

## Option 1: Blackmagic FFmpeg (Empfohlen für SDI)

Blackmagic FFmpeg mit DeckLink-Support muss manuell platziert werden.

### Schritt 1: FFmpeg mit DeckLink-Support kompilieren

**Voraussetzungen:**
- Blackmagic Desktop Video SDK installiert
- FFmpeg Source Code
- Build-Tools (Compiler, etc.)

**Anleitung:**

1. **Desktop Video SDK herunterladen:**
   - Download von: https://www.blackmagicdesign.com/support/family/desktop-video-sdk
   - SDK installieren/entpacken

2. **FFmpeg Source Code klonen:**
   ```bash
   git clone https://git.ffmpeg.org/ffmpeg.git ffmpeg
   cd ffmpeg
   ```

3. **FFmpeg mit DeckLink-Support konfigurieren:**
   ```bash
   ./configure \
     --enable-gpl \
     --enable-nonfree \
     --enable-decklink \
     --extra-cflags="-I/PATH/TO/DECKLINK/SDK/include" \
     --extra-ldflags="-L/PATH/TO/DECKLINK/SDK/lib"
   ```
   
   Ersetze `/PATH/TO/DECKLINK/SDK` mit dem tatsächlichen Pfad zum DeckLink SDK.

4. **FFmpeg kompilieren:**
   ```bash
   make -j$(nproc)  # Linux/macOS
   # oder
   make -j%NUMBER_OF_PROCESSORS%  # Windows
   ```

5. **FFmpeg-Binary extrahieren:**
   - Das kompilierte Binary befindet sich in `ffmpeg/ffmpeg` (Unix) oder `ffmpeg/ffmpeg.exe` (Windows)

### Schritt 2: FFmpeg in Bridge platzieren

**Verzeichnisstruktur:**
```
resources/ffmpeg/
  mac-arm64/
    ffmpeg
  mac-x64/
    ffmpeg
  win/
    ffmpeg.exe
  linux/
    ffmpeg
```

**macOS (arm64):**
```bash
cp ffmpeg resources/ffmpeg/mac-arm64/ffmpeg
chmod +x resources/ffmpeg/mac-arm64/ffmpeg
```

**macOS (x64):**
```bash
cp ffmpeg resources/ffmpeg/mac-x64/ffmpeg
chmod +x resources/ffmpeg/mac-x64/ffmpeg
```

**Windows:**
```bash
copy ffmpeg.exe resources\ffmpeg\win\ffmpeg.exe
```

**Linux:**
```bash
cp ffmpeg resources/ffmpeg/linux/ffmpeg
chmod +x resources/ffmpeg/linux/ffmpeg
```

### Schritt 3: DeckLink-Support prüfen

```bash
# Prüfe ob DeckLink-Support vorhanden ist
ffmpeg -formats | grep decklink

# Sollte "decklink" anzeigen

# Teste Device-Liste
ffmpeg -f decklink -list_devices 1 -i dummy

# Sollte Liste der DeckLink-Devices anzeigen
```

## Option 2: BtbN FFmpeg (Nur für NDI)

Die automatisch heruntergeladenen BtbN FFmpeg-Builds funktionieren für NDI-Output, haben aber möglicherweise **keinen** DeckLink-Support.

**Verwendung:**
- Automatisch heruntergeladen mit `npm run download:ffmpeg`
- Funktioniert für NDI-Output
- **Nicht** für SDI-Output geeignet

## Option 3: System FFmpeg

Falls System-FFmpeg mit DeckLink-Support installiert ist, kann `FFMPEG_PATH` gesetzt werden:

```bash
export FFMPEG_PATH=/usr/local/bin/ffmpeg  # macOS/Linux
# oder
set FFMPEG_PATH=C:\ffmpeg\ffmpeg.exe  # Windows
```

## Prüfung beim Bridge-Start

Die Bridge führt beim Start automatisch einen Self-Test durch:

- **✓ DeckLink support: Available** → SDI-Output funktioniert
- **✗ DeckLink support: NOT AVAILABLE** → SDI-Output funktioniert nicht, NDI funktioniert weiterhin

## Troubleshooting

**Problem: "FFmpeg does not have DeckLink support"**

**Lösung:**
1. Stelle sicher, dass Blackmagic FFmpeg in `resources/ffmpeg/` platziert ist
2. Prüfe ob FFmpeg DeckLink-Support hat: `ffmpeg -formats | grep decklink`
3. Falls nicht: FFmpeg mit `--enable-decklink` neu kompilieren

**Problem: "Blackmagic Desktop Video may not be installed" (macOS)**

**Lösung:**
1. Download Blackmagic Desktop Video von: https://www.blackmagicdesign.com/support
2. Installiere Desktop Video
3. Bridge neu starten

**Problem: Keine DeckLink-Devices gefunden**

**Lösung:**
1. Prüfe ob DeckLink-Karte angeschlossen ist
2. Prüfe ob Desktop Video Treiber installiert sind
3. Prüfe ob FFmpeg DeckLink-Support hat: `ffmpeg -f decklink -list_devices 1 -i dummy`

## Zusammenfassung

| Use Case | FFmpeg-Typ | DeckLink-Support | Automatisch |
|----------|------------|------------------|-------------|
| SDI-Output | Blackmagic FFmpeg | ✓ Ja | ✗ Manuell |
| NDI-Output | BtbN FFmpeg | ? Unbekannt | ✓ Automatisch |
| Beides | Blackmagic FFmpeg | ✓ Ja | ✗ Manuell |

**Empfehlung:** Für Production mit SDI-Output: Blackmagic FFmpeg manuell platzieren.

