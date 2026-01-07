# FFmpeg Minimal-Build: Lizenz-optimierte Konfiguration

## Ziel

FFmpeg mit DeckLink-Support kompilieren, **ohne** `--enable-gpl` und **ohne** `--enable-nonfree`, um Lizenzrisiken zu minimieren.

## Problem

**Aktuelle Konfiguration:**

```bash
./configure \
  --enable-gpl \        # ❌ GPL-Pflichten
  --enable-nonfree \    # ❌ Nicht redistributable
  --enable-decklink
```

**Ziel-Konfiguration:**

```bash
./configure \
  --enable-decklink \   # ✅ Nur DeckLink
  # OHNE --enable-gpl
  # OHNE --enable-nonfree
```

## Test-Anleitung

### Schritt 1: FFmpeg Source Code klonen

```bash
git clone https://git.ffmpeg.org/ffmpeg.git ffmpeg-minimal
cd ffmpeg-minimal
```

### Schritt 2: Minimal-Build konfigurieren

```bash
./configure \
  --enable-decklink \
  --extra-cflags="-I/PATH/TO/DECKLINK/SDK/include" \
  --extra-ldflags="-L/PATH/TO/DECKLINK/SDK/lib"
```

**Wichtig:** Keine `--enable-gpl` oder `--enable-nonfree` Flags!

### Schritt 3: FFmpeg kompilieren

```bash
make -j$(nproc)  # Linux/macOS
# oder
make -j%NUMBER_OF_PROCESSORS%  # Windows
```

### Schritt 4: DeckLink-Support testen

```bash
# Prüfe ob DeckLink-Support vorhanden ist
./ffmpeg -formats | grep decklink

# Sollte "decklink" anzeigen

# Teste Device-Liste
./ffmpeg -f decklink -list_devices 1 -i dummy

# Sollte Liste der DeckLink-Devices anzeigen
```

### Schritt 5: Lizenz-Status prüfen

```bash
# Prüfe welche Codecs/Bibliotheken aktiviert sind
./ffmpeg -version

# Prüfe ob GPL-Codecs aktiviert sind
./ffmpeg -codecs | grep -i gpl

# Sollte keine GPL-Codecs anzeigen (wenn Minimal-Build erfolgreich)
```

## Erwartete Ergebnisse

### Erfolg: Minimal-Build funktioniert

- ✅ DeckLink-Support vorhanden
- ✅ Keine GPL-Codecs aktiviert
- ✅ Keine nonfree-Codecs aktiviert
- ✅ **Lizenz:** Nur LGPL (keine GPL-Pflichten)

### Problem: DeckLink erfordert nonfree

- ❌ `configure` schlägt fehl ohne `--enable-nonfree`
- ❌ Oder: DeckLink-Support funktioniert nicht

**Lösung:**

- Prüfen ob DeckLink wirklich `--enable-nonfree` erfordert
- Alternative: Blackmagic kontaktieren für Lizenz-Klärung

## Alternative: FFmpeg mit GPL akzeptieren

Falls Minimal-Build nicht funktioniert:

### Option A: GPL akzeptieren + Quellcode bereitstellen

1. FFmpeg mit `--enable-gpl` kompilieren
2. **GPL-Quellcode bereitstellen:**
   - Build-Skripte
   - Konfiguration
   - Patches (falls vorhanden)
   - Link zu FFmpeg Source Code
3. GPL-Lizenztext in App beifügen
4. Lizenzhinweise in App

### Option B: Nur nonfree (ohne GPL)

```bash
./configure \
  --enable-nonfree \    # ⚠️ Nicht redistributable
  --enable-decklink
```

**Problem:** FFmpeg.org warnt: "Do not redistribute binaries built with this option"

**Lösung:** Kunde muss FFmpeg selbst kompilieren (nicht praktikabel)

## Dokumentation der Ergebnisse

Nach dem Test:

1. **Ergebnis dokumentieren:**

   - Funktioniert Minimal-Build?
   - Welche Flags sind minimal erforderlich?
   - Welche Lizenz gilt?

2. **Build-Skript erstellen:**

   - Automatisiertes Build-Skript für Minimal-Build
   - Oder: Build-Skript für GPL-Build mit Quellcode-Bereitstellung

3. **Lizenzhinweise aktualisieren:**
   - Basierend auf tatsächlicher Konfiguration
   - GPL-Lizenztext (falls GPL aktiviert)
   - Quellcode-Link (falls GPL aktiviert)

## Nächste Schritte

1. ⏳ Minimal-Build testen (siehe oben)
2. ⏳ Ergebnisse dokumentieren
3. ⏳ Build-Skript erstellen (falls Minimal-Build funktioniert)
4. ⏳ Lizenzhinweise aktualisieren
