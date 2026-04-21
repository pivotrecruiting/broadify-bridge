# Integration – QA Checklist

Ziel: Abschlussprüfung für die Integrations‑Doku.

## Dokument‑Vollständigkeit
- [x] Architektur‑Overview vorhanden
- [x] E2E‑Flows vorhanden (Graphics, Device‑Discovery, Health/Status, Logging, Relay)
- [x] Schnittstellen‑Übersicht vorhanden
- [x] Glossar/Fehlerkatalog/Konfig‑Schemas vorhanden

## Diagramme & Links
- [x] Alle Flows enthalten Mermaid‑Diagramme
- [x] README verlinkt alle Integrations‑Docs
- [ ] Links zu Code‑Dateien stichprobenartig geprüft

## Inhaltliche Checks
- [x] Security‑Hinweise pro Flow vorhanden
- [x] Error‑Cases beschrieben
- [x] Payload‑Beispiele stichprobenartig geprüft

## ATEM Macro Feedback
- [x] Engine-State und Macro-Execution-Contract dokumentiert
- [x] Relay-Events `engine_status`, `engine_macro_execution`, `engine_error` dokumentiert
- [x] QA-Runbook fuer normales Macro, Wait-Macro, Stop, Loop, Bridge-Reconnect und Webapp-Reconnect vorhanden
- [ ] Realgeraete-Test mit ATEM-Modell/Firmware im Release-Protokoll eintragen

## Offene Punkte (falls vorhanden)
- [ ] ATEM-Realgeraete-Test pro Release dokumentieren
