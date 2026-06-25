# Integration – Fehlerkatalog (Auszug)

## Bridge
- **Outputs not configured**: Output‑Config fehlt → erst `graphics_configure_outputs` senden
- **Output format not supported**: Format passt nicht zu Display‑Modes
- **DeckLink helper not executable**: Helper‑Binary fehlt oder keine Exec‑Rechte
- **Port not available**: Port belegt oder nicht verfügbar

## Canon XC
- **permission_denied / EPERM / EACCES**: macOS blockiert die lokale Netzwerkverbindung → Local Network für „Broadify Bridge“ erlauben und App neu starten
- **network_unreachable / ENETUNREACH / EHOSTUNREACH**: Kamera-Netz ist vom Mac nicht erreichbar → aktives Interface, VLAN/Subnetz und Routing prüfen
- **connection_refused / ECONNREFUSED**: Host antwortet, aber Port/Protokoll passt nicht → Canon-Port und HTTP/HTTPS-Einstellung prüfen
- **timeout / ETIMEDOUT**: Keine rechtzeitige Antwort → Adresse, Port, Kamera-Netzwerkmodus, Firewall und Local Network Permission prüfen

## Desktop
- **Port already in use**: Bridge kann Port nicht binden (Health‑Check Fehler)
- **Bridge not reachable**: Bridge läuft nicht oder falscher Host
- **Engine not connected**: Engine‑Aktionen vor Connect

## Relay
- **command_result success=false**: Fehler im CommandRouter oder Validation
