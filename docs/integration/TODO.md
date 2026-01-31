# Dokumentations-TODO – Integration (Desktop ↔ Bridge ↔ Helper)

Ziel: Systemweite Doku, die die Verbindungen und Verantwortlichkeiten zwischen Desktop-App, Bridge und nativen Helpern erklärt.

## Stufe 1 – Architektur & Struktur (High-Level)
- [x] Systemüberblick (Desktop, Bridge, Helper, externe Systeme)
- [x] Gesamtarchitekturdiagramm (Mermaid)
- [x] End-to-End Datenfluss: UI-Aktion → Output-Frame
- [x] Security-Boundaries zwischen Prozessen/Netzwerk

## Stufe 2 – Schnittstellen (Mid-Level)
- [ ] IPC- und API-Schnittstellen Desktop ↔ Bridge
- [ ] Relay-Flow (Cloud ↔ Bridge ↔ Desktop falls relevant)
- [ ] Helper-Protokolle (DeckLink List/Modes/Playback)
- [ ] Konfig-Pfade (UserData, Assets, Output-Config)

## Stufe 3 – Feature-Flows (Deep-Dive)
- [x] Graphics-Setup-Flow (Outputs → Render → SDI/HDMI)
- [x] Device-Discovery-Flow (Detect → Cache → UI)
- [ ] Health/Status-Flow (Status-Endpoints, WebSocket)
- [ ] Logging- und Diagnose-Flow (Desktop/Bridge/Helper)

## Stufe 4 – Referenzen & Glossar
- [ ] Begriffe/Abkürzungen (OutputKey, Layer, Preset, PortRole)
- [ ] Fehlerkatalog (häufige Fehler + Ursachen)
- [ ] Konfig-Schema-Referenzen (Zod/JSON)

## Abnahmekriterien (Definition of Done)
- [ ] In `docs/integration/` existieren Stufe‑Docs mit klarer Navigation
- [x] Mermaid-Diagramme für jeden Hauptflow
- [ ] Alle Schnittstellen sind mit Payloads & Beispielen dokumentiert
