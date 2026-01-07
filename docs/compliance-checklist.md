# Lizenz-Compliance Checkliste

## Vor kommerzieller Distribution

### 1. SDK-Lizenzen prüfen

- [ ] **Blackmagic DeckLink SDK EULA gelesen**
  - [ ] Redistribution von FFmpeg mit DeckLink-Support erlaubt?
  - [ ] Kommerzielle Nutzung erlaubt?
  - [ ] Credits/Acknowledgments erforderlich?
  - [ ] Separate Lizenz erforderlich?

- [ ] **NewTek NDI SDK Lizenz geprüft**
  - [ ] Kommerzielle Lizenz erworben? (falls NDI verwendet)
  - [ ] Redistribution von FFmpeg mit NDI-Support erlaubt?
  - [ ] Credits/Acknowledgments erforderlich?

- [ ] **BtbN FFmpeg Builds Lizenz geprüft**
  - [ ] Repository-Lizenz gelesen
  - [ ] Redistribution erlaubt?
  - [ ] Credits erforderlich?

### 2. FFmpeg Lizenz-Compliance

- [ ] **FFmpeg Build-Konfiguration dokumentiert**
  - [ ] Welche Flags wurden verwendet?
  - [ ] GPL aktiviert? (`--enable-gpl`)
  - [ ] Nonfree aktiviert? (`--enable-nonfree`)

- [ ] **GPL-Compliance (falls GPL aktiviert)**
  - [ ] GPL-Quellcode bereitgestellt?
  - [ ] Build-Skripte dokumentiert?
  - [ ] Konfiguration dokumentiert?
  - [ ] Patches dokumentiert (falls vorhanden)?
  - [ ] GPL-Lizenztext in App beigefügt?
  - [ ] Lizenzhinweise in App?

- [ ] **LGPL-Compliance (falls nur LGPL)**
  - [ ] FFmpeg als externes Binary (nicht statisch gelinkt)?
  - [ ] Benutzer kann FFmpeg-Binary ersetzen?
  - [ ] LGPL-Lizenztext in App beigefügt?

- [ ] **Nonfree-Compliance (falls nonfree aktiviert)**
  - [ ] Redistribution erlaubt? (FFmpeg.org warnt davor)
  - [ ] Alternative Lösung gefunden? (Kunde kompiliert selbst?)

### 3. Lizenzhinweise in App

- [ ] **LICENSE-Datei erstellt**
  - [ ] Alle verwendeten Lizenzen aufgelistet
  - [ ] GPL-Lizenztext (falls GPL aktiviert)
  - [ ] LGPL-Lizenztext (falls LGPL)
  - [ ] SDK-Credits (Blackmagic, NewTek)

- [ ] **NOTICES.md erstellt**
  - [ ] FFmpeg Credits
  - [ ] DeckLink SDK Credits
  - [ ] NDI Credits (falls verwendet)
  - [ ] Quellcode-Links

- [ ] **About-Dialog in App**
  - [ ] Lizenzhinweise
  - [ ] Credits
  - [ ] Quellcode-Links

### 4. Build-Prozess dokumentiert

- [ ] **Build-Skripte dokumentiert**
  - [ ] FFmpeg Build-Skript
  - [ ] Konfiguration dokumentiert
  - [ ] Abhängigkeiten dokumentiert

- [ ] **Quellcode-Repository**
  - [ ] FFmpeg Source Code verfügbar?
  - [ ] Build-Skripte verfügbar?
  - [ ] Konfiguration verfügbar?

### 5. Rechtliche Beratung

- [ ] **Anwalt konsultiert**
  - [ ] Software-Lizenz-Spezialist
  - [ ] Compliance-Plan erstellt
  - [ ] Risiken bewertet

- [ ] **Compliance-Plan erstellt**
  - [ ] Alle Lizenzen dokumentiert
  - [ ] Compliance-Maßnahmen definiert
  - [ ] Risiken identifiziert

### 6. Testing

- [ ] **FFmpeg Minimal-Build getestet**
  - [ ] Funktioniert DeckLink ohne GPL/nonfree?
  - [ ] Ergebnisse dokumentiert

- [ ] **Lizenzhinweise getestet**
  - [ ] LICENSE-Datei korrekt?
  - [ ] NOTICES.md korrekt?
  - [ ] About-Dialog korrekt?

## Nach kommerzieller Distribution

### 7. Wartung

- [ ] **Lizenz-Updates überwachen**
  - [ ] SDK-Lizenzen ändern sich?
  - [ ] FFmpeg-Lizenzen ändern sich?
  - [ ] Compliance-Plan aktualisieren

- [ ] **Quellcode aktuell halten**
  - [ ] FFmpeg Source Code aktuell?
  - [ ] Build-Skripte aktuell?

## Risiko-Bewertung

### Niedriges Risiko ✅

- FFmpeg nur mit LGPL (ohne GPL/nonfree)
- Alle SDK-Lizenzen geprüft und erlaubt
- Lizenzhinweise korrekt

### Mittleres Risiko ⚠️

- FFmpeg mit GPL (aber Quellcode bereitgestellt)
- SDK-Lizenzen unklar
- Lizenzhinweise vorhanden

### Hohes Risiko ❌

- FFmpeg mit `--enable-nonfree` (nicht redistributable)
- SDK-Lizenzen nicht geprüft
- Keine Lizenzhinweise
- Keine Quellcode-Bereitstellung (bei GPL)

## Empfehlung

**Vor kommerzieller Distribution:**

1. ✅ Alle SDK-Lizenzen prüfen
2. ✅ FFmpeg Minimal-Build testen
3. ✅ Rechtliche Beratung einholen
4. ✅ Compliance-Plan erstellen
5. ✅ Lizenzhinweise in App erstellen
6. ✅ Build-Prozess dokumentieren

**Nicht verteilen ohne:**
- ❌ SDK-Lizenzen geprüft
- ❌ FFmpeg-Lizenz geklärt
- ❌ Rechtliche Beratung eingeholt
- ❌ Compliance-Plan erstellt

