# Lizenz-Compliance: Zusammenfassung

## Erledigte Aufgaben

### ✅ 1. SDK-Lizenzen recherchiert

**Dokumentiert in:** `docs/license-analysis.md`

**Ergebnisse:**
- **Blackmagic DeckLink SDK:** Proprietäre Lizenz, EULA muss von Blackmagic Design Website gelesen werden
- **NewTek NDI SDK:** Proprietäre Lizenz, kommerzielle Nutzung erfordert separate Lizenz
- **BtbN FFmpeg Builds:** Lizenz muss von GitHub Repository geprüft werden

**Aktionen erforderlich:**
- [ ] Blackmagic DeckLink SDK EULA lesen
- [ ] NewTek NDI SDK Lizenz prüfen (für kommerzielle Nutzung)
- [ ] BtbN FFmpeg Builds Lizenz prüfen

---

### ✅ 2. FFmpeg Minimal-Build Anleitung erstellt

**Dokumentiert in:** `docs/ffmpeg-minimal-build.md`

**Ziel:** FFmpeg nur mit DeckLink, ohne `--enable-gpl` und `--enable-nonfree`

**Status:** Anleitung erstellt, Test noch ausstehend

**Aktionen erforderlich:**
- [ ] Minimal-Build testen (siehe `docs/ffmpeg-minimal-build.md`)
- [ ] Ergebnisse dokumentieren
- [ ] Build-Skript erstellen (falls Minimal-Build funktioniert)

---

### ✅ 3. Compliance-Checkliste erstellt

**Dokumentiert in:** `docs/compliance-checklist.md`

**Inhalt:**
- Checkliste für SDK-Lizenzen
- FFmpeg Lizenz-Compliance
- Lizenzhinweise in App
- Build-Prozess Dokumentation
- Rechtliche Beratung

**Status:** Checkliste erstellt, Items müssen abgearbeitet werden

---

### ✅ 4. Lizenzhinweise in App erstellt

**Erstellt:**
- `LICENSE` - Haupt-Lizenz-Datei mit LGPL/GPL Texten
- `NOTICES.md` - Third-Party Notices und Credits

**Status:** Dateien erstellt, müssen noch in App integriert werden (About-Dialog)

**Aktionen erforderlich:**
- [ ] About-Dialog in App erstellen (Settings-Button im Header)
- [ ] Lizenzhinweise in About-Dialog anzeigen
- [ ] Links zu LICENSE und NOTICES.md

---

### ✅ 5. Build-Prozess dokumentiert

**Dokumentiert in:** `docs/build-process.md`

**Inhalt:**
- Build-Abhängigkeiten
- Build-Schritte
- FFmpeg Build-Prozess (Minimal-Build und GPL-Build)
- Build-Skripte
- Lizenz-Compliance während Build

**Status:** Dokumentation erstellt

---

## Nächste Schritte

### Sofortige Aktionen

1. **SDK-Lizenzen prüfen:**
   - Blackmagic DeckLink SDK EULA lesen
   - NewTek NDI SDK Lizenz prüfen
   - BtbN FFmpeg Builds Lizenz prüfen

2. **FFmpeg Minimal-Build testen:**
   - Siehe `docs/ffmpeg-minimal-build.md`
   - Prüfen ob DeckLink ohne GPL/nonfree funktioniert

3. **Rechtliche Beratung:**
   - Anwalt für Software-Lizenzen konsultieren
   - Compliance-Plan erstellen

### Mittelfristige Aktionen

4. **About-Dialog in App:**
   - Settings-Button im Header funktional machen
   - About-Dialog mit Lizenzhinweisen erstellen

5. **Build-Skripte:**
   - `scripts/build-ffmpeg-decklink.js` erstellen
   - Automatische Lizenz-Checks implementieren

---

## Risiko-Bewertung

### Aktueller Status: ⚠️ Mittleres Risiko

**Gründe:**
- FFmpeg mit `--enable-gpl` + `--enable-nonfree` (laut `docs/ffmpeg-setup.md`)
- SDK-Lizenzen noch nicht geprüft
- Rechtliche Beratung noch nicht eingeholt

**Reduzierung auf Niedriges Risiko:**
- ✅ SDK-Lizenzen prüfen
- ✅ FFmpeg Minimal-Build testen
- ✅ Rechtliche Beratung einholen
- ✅ Compliance-Plan erstellen

---

## Dokumentations-Struktur

```
docs/
  license-analysis.md          # SDK-Lizenzen Analyse
  ffmpeg-minimal-build.md      # Minimal-Build Anleitung
  compliance-checklist.md       # Compliance Checkliste
  build-process.md             # Build-Prozess Dokumentation
  license-summary.md           # Diese Datei

LICENSE                        # Haupt-Lizenz-Datei
NOTICES.md                     # Third-Party Notices
```

---

## Kontakt

Für Fragen zur Lizenz-Compliance:
- Siehe `docs/compliance-checklist.md`
- Siehe `docs/license-analysis.md`
- Rechtliche Beratung empfohlen

