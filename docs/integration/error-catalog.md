# Integration – Fehlerkatalog (Auszug)

## Bridge
- **Outputs not configured**: Output‑Config fehlt → erst `graphics_configure_outputs` senden
- **Output format not supported**: Format passt nicht zu Display‑Modes
- **DeckLink helper not executable**: Helper‑Binary fehlt oder keine Exec‑Rechte
- **Port not available**: Port belegt oder nicht verfügbar

## Desktop
- **Port already in use**: Bridge kann Port nicht binden (Health‑Check Fehler)
- **Bridge not reachable**: Bridge läuft nicht oder falscher Host
- **Engine not connected**: Engine‑Aktionen vor Connect

## Relay
- **command_result success=false**: Fehler im CommandRouter oder Validation
