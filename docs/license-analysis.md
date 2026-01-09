# Lizenz-Analyse: SDK-Lizenzen und Compliance

## 1. Blackmagic DeckLink SDK

### Lizenz-Status
- **Lizenztyp:** Proprietäre Lizenz von Blackmagic Design
- **Verwendung:** Zur Build-Zeit (falls verwendet)
- **Redistribution:** SDK selbst wird nicht mitgeliefert

### Wichtige Punkte
- SDK darf verwendet werden, um Software zu entwickeln, die mit Blackmagic-Hardware interagiert
- Lizenzvereinbarung muss von Blackmagic Design Website gelesen werden
- **Empfehlung:** EULA von https://www.blackmagicdesign.com/support/family/desktop-video-sdk prüfen

### Rechtliche Überlegungen
- SDK darf zur Entwicklung verwendet werden
- **Aktion erforderlich:** SDK EULA lesen und rechtliche Beratung einholen

---

## 2. NewTek NDI SDK

### Lizenz-Status
- **Lizenztyp:** Proprietäre Lizenz von NewTek (Vizrt)
- **Verwendung:** Falls NDI verwendet wird
- **Kommerzielle Nutzung:** Erfordert separate Lizenz

### Wichtige Punkte
- NDI SDK ist kostenlos für Entwicklung
- **Kommerzielle Distribution erfordert Lizenz**
- Lizenzkosten: Abhängig von Nutzung (kann teuer sein)

### Rechtliche Überlegungen
- NDI SDK enthält proprietären Code
- **Problem:** Redistribution möglicherweise nicht erlaubt
- **Aktion erforderlich:** NewTek kontaktieren für kommerzielle Lizenz

### Empfehlung
- **Option A:** NewTek-Lizenz erwerben (für kommerzielle Distribution)
- **Option B:** NDI als optionales Feature (Kunde installiert NDI selbst - nicht praktikabel)
- **Option C:** NDI-Funktion deaktivieren bis Lizenz geklärt

---

## 3. Zusammenfassung: Kritische Punkte

### Sofortige Aktionen erforderlich

1. **Blackmagic DeckLink SDK EULA lesen**
   - Website: https://www.blackmagicdesign.com/support/family/desktop-video-sdk
   - Prüfen: SDK-Nutzung und Redistribution erlaubt?

2. **NewTek NDI SDK Lizenz prüfen**
   - Kontakt: NewTek/Vizrt für kommerzielle Lizenz
   - Prüfen: Kommerzielle Nutzung und Redistribution erlaubt?

### Rechtliche Beratung empfohlen

- **Anwalt konsultieren** für Software-Lizenzen
- Compliance-Plan erstellen
- Lizenz-Compliance dokumentieren

---

## 4. Nächste Schritte

1. ✅ SDK-Lizenzen recherchiert (siehe oben)
2. ⏳ Rechtliche Beratung einholen (Compliance-Checkliste in `docs/compliance-checklist.md`)
3. ⏳ Lizenzhinweise in App erstellen (siehe `LICENSE` und `NOTICES.md`)
4. ⏳ Build-Prozess dokumentieren (siehe `docs/build-process.md`)

