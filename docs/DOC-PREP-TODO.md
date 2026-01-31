# Dokumentations-Vorbereitung – Code Review & Inline-Doku

Ziel: Bevor eine Dokumentation geschrieben wird, wird der relevante Code vollständig geprüft und in den Ziel-Dateien mit Inline-Kommentaren sowie JSDoc-Parametern ergänzt. Dadurch ist die spätere Doku konsistent und lückenlos.

## Workflow (immer vor jeder Doku-Stufe)
- [ ] Ziel-Datei + direkte Abhängigkeiten ermitteln
- [ ] Code vollständig lesen (inkl. angrenzender Module)
- [ ] Fehlende Inline-Kommentare ergänzen (Englisch)
- [ ] Fehlende JSDoc für public APIs/Utilities/Module ergänzen (Englisch)
- [ ] Security-Risiken markieren und Mitigation im Code kommentieren
- [ ] Eventuelle Unklarheiten als Fragen notieren (kein Raten)
- [ ] Erst danach: Dokumentation schreiben

## Checkliste pro Datei-Block
- [ ] Zweck des Moduls klar im Code kommentiert
- [ ] Public Funktionen mit JSDoc (params/returns/errors)
- [ ] Wichtige Datenstrukturen erklärt
- [ ] Nebenwirkungen & IO (FS/Netz/IPC/Prozess) kommentiert
- [ ] Edge-Cases & Fehlerbehandlung klar

## Abnahmekriterien
- [ ] Inline-Kommentare sind präzise, nicht redundant
- [ ] JSDoc deckt alle public APIs ab
- [ ] Security-Hinweise sind explizit
- [ ] Fragen sind vor Doku schriftlich geklärt
