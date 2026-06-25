# Integration – Fehlerkatalog (Auszug)

## Bridge
- **Outputs not configured**: Output‑Config fehlt → erst `graphics_configure_outputs` senden
- **Output format not supported**: Format passt nicht zu Display‑Modes
- **DeckLink helper not executable**: Helper‑Binary fehlt oder keine Exec‑Rechte
- **Port not available**: Port belegt oder nicht verfügbar

## Engine / ATEM (macOS)
- **CONNECTION_TIMEOUT / Connection timeout (ATEM)**: Keine Antwort auf UDP `:9910` → oft macOS „Lokales Netzwerk"-Berechtigung fehlt oder TCC-Eintrag hängt; Windows im gleichen Netz funktioniert typischerweise normal
- **Support-Workaround (TCC hängt)**: Broadify Bridge beenden → Systemeinstellungen → Datenschutz & Sicherheit → Lokales Netzwerk → Haken bei „Broadify Bridge" (ggf. auch „Broadify Bridge RC") **entfernen** → **Mac neu starten** → App starten → Berechtigung neu erteilen → ATEM erneut verbinden
- **Erstversuch (Freigabe fehlt)**: Haken setzen, App neu starten (Cmd+Q)
- **RC vs. Release**: `com.broadify.bridge.rc` und `com.broadify.bridge` sind getrennte Apps — jeweils eigene Local-Network-Freigabe nötig
- **Abgrenzung**: ATEM Software Control am Mac ok, Broadify timeout → Permission für Broadify; beides timeout → Netzwerk (Subnetz, VLAN, VPN, Firewall)

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
