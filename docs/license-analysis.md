# Lizenz-Analyse: SDK-Lizenzen und Compliance

## 1. Blackmagic DeckLink SDK

### Lizenz-Status
- **Lizenztyp:** Proprietäre Lizenz von Blackmagic Design
- **Verwendung:** Zur Build-Zeit (FFmpeg wird gegen SDK gelinkt)
- **Redistribution:** SDK selbst wird nicht mitgeliefert

### Wichtige Punkte
- SDK darf verwendet werden, um Software zu entwickeln, die mit Blackmagic-Hardware interagiert
- Lizenzvereinbarung muss von Blackmagic Design Website gelesen werden
- **Empfehlung:** EULA von https://www.blackmagicdesign.com/support/family/desktop-video-sdk prüfen

### Rechtliche Überlegungen
- FFmpeg-Binary enthält DeckLink-Support (gegen SDK gelinkt)
- **Frage:** Darf FFmpeg mit DeckLink-Support weiterverteilt werden?
- **Aktion erforderlich:** SDK EULA lesen und rechtliche Beratung einholen

---

## 2. NewTek NDI SDK

### Lizenz-Status
- **Lizenztyp:** Proprietäre Lizenz von NewTek (Vizrt)
- **Verwendung:** FFmpeg nutzt `libndi_newtek` Format
- **Kommerzielle Nutzung:** Erfordert separate Lizenz

### Wichtige Punkte
- NDI SDK ist kostenlos für Entwicklung
- **Kommerzielle Distribution erfordert Lizenz**
- Lizenzkosten: Abhängig von Nutzung (kann teuer sein)

### Rechtliche Überlegungen
- FFmpeg mit `libndi_newtek` enthält NDI-Code
- **Problem:** Redistribution möglicherweise nicht erlaubt
- **Aktion erforderlich:** NewTek kontaktieren für kommerzielle Lizenz

### Empfehlung
- **Option A:** NewTek-Lizenz erwerben (für kommerzielle Distribution)
- **Option B:** NDI als optionales Feature (Kunde installiert NDI selbst - nicht praktikabel)
- **Option C:** NDI-Funktion deaktivieren bis Lizenz geklärt

---

## 3. BtbN FFmpeg Builds

### Lizenz-Status
- **Quelle:** GitHub Repository: BtbN/FFmpeg-Builds
- **Lizenz:** Abhängig von FFmpeg-Konfiguration
- **DeckLink-Support:** Standard-Builds haben **keinen** DeckLink-Support

### Wichtige Punkte
- BtbN Builds sind statische FFmpeg-Builds
- Möglicherweise eigene Lizenzbedingungen
- **Prüfung nötig:** BtbN Repository-Lizenz lesen

### Rechtliche Überlegungen
- BtbN Builds dürfen möglicherweise nicht weiterverteilt werden
- **Aktion erforderlich:** BtbN Repository-Lizenz prüfen (GitHub)

### Empfehlung
- **Option A:** BtbN Lizenzbedingungen prüfen
- **Option B:** Eigene FFmpeg-Builds erstellen (bessere Kontrolle)

---

## 4. FFmpeg Lizenz-Situation

### Aktuelle Konfiguration (laut `docs/ffmpeg-setup.md`)
```bash
./configure \
  --enable-gpl \
  --enable-nonfree \
  --enable-decklink
```

### Lizenz-Implikationen

**Mit `--enable-gpl`:**
- FFmpeg wird unter **GPL v2+** lizenziert
- **GPL-Pflichten:**
  - Quellcode des kompilierten FFmpeg muss verfügbar sein
  - Lizenzhinweise müssen beigelegt werden
  - GPL-Lizenztext muss enthalten sein
  - Änderungen am FFmpeg-Code müssen dokumentiert werden

**Mit `--enable-nonfree`:**
- Enthält proprietäre Codecs/Bibliotheken
- **Nicht frei redistributable**
- FFmpeg.org warnt: "Do not redistribute binaries built with this option"

**Kombination `--enable-gpl` + `--enable-nonfree`:**
- **Mischpaket aus GPL + proprietären Komponenten**
- Mindestens eine Lizenz sagt "Nein" zur Redistribution
- **Rechtlich problematisch**

### Minimal-Build Test (Empfehlung)

**Ziel:** FFmpeg nur mit DeckLink, ohne GPL/nonfree

```bash
./configure \
  --enable-decklink \
  --extra-cflags="-I/PATH/TO/DECKLINK/SDK/include" \
  --extra-ldflags="-L/PATH/TO/DECKLINK/SDK/lib"
# OHNE --enable-gpl
# OHNE --enable-nonfree (wenn möglich)
```

**Problem:** DeckLink erfordert möglicherweise `--enable-nonfree`

**Vorteil:** Nur LGPL, keine GPL-Pflichten

**Test erforderlich:** Minimal-Build kompilieren und testen

---

## 5. Zusammenfassung: Kritische Punkte

### Sofortige Aktionen erforderlich

1. **Blackmagic DeckLink SDK EULA lesen**
   - Website: https://www.blackmagicdesign.com/support/family/desktop-video-sdk
   - Prüfen: Redistribution von FFmpeg mit DeckLink-Support erlaubt?

2. **NewTek NDI SDK Lizenz prüfen**
   - Kontakt: NewTek/Vizrt für kommerzielle Lizenz
   - Prüfen: Redistribution von FFmpeg mit NDI-Support erlaubt?

3. **BtbN FFmpeg Builds Lizenz prüfen**
   - Repository: https://github.com/BtbN/FFmpeg-Builds
   - Prüfen: Redistribution erlaubt?

4. **FFmpeg Minimal-Build testen**
   - Test: FFmpeg ohne `--enable-gpl` und `--enable-nonfree` kompilieren
   - Prüfen: Funktioniert DeckLink-Support?

### Rechtliche Beratung empfohlen

- **Anwalt konsultieren** für Software-Lizenzen
- Compliance-Plan erstellen
- Lizenz-Compliance dokumentieren

---

## 6. Nächste Schritte

1. ✅ SDK-Lizenzen recherchiert (siehe oben)
2. ⏳ FFmpeg Minimal-Build testen (Anleitung in `docs/ffmpeg-minimal-build.md`)
3. ⏳ Rechtliche Beratung einholen (Compliance-Checkliste in `docs/compliance-checklist.md`)
4. ⏳ Lizenzhinweise in App erstellen (siehe `LICENSE` und `NOTICES.md`)
5. ⏳ Build-Prozess dokumentieren (siehe `docs/build-process.md`)

