# Integration – Fehlerkatalog (Auszug)

## Bridge
- **Outputs not configured**: Output‑Config fehlt → erst `graphics_configure_outputs` senden
- **Output format not supported**: Format passt nicht zu Display‑Modes
- **DeckLink helper not executable**: Helper‑Binary fehlt oder keine Exec‑Rechte
- **Native display helper could not start (STATUS_DLL_NOT_FOUND)** / `diagnostics.display.state = missing_runtime` (Windows, Exit-Code 3221225781 = 0xC0000135, auch 0xC0000139 / 0xC0000142): `display-helper.exe` stirbt vor `main()`, weil die Microsoft-Visual-C++-Runtime fehlt → `vc_redist.x64` installieren oder Bridge neu installieren, dann Bridge neu starten; HDMI-Ausgänge fehlen bis dahin in `/outputs`; Log-Event `windows_display_helper_failed`; Details `docs/bridge/analysis/windows-display-helper-loader-diagnostics.md`
- **Native display helper exited with code N** / `diagnostics.display.state = helper_failed`: Display-Helper lief, aber Erkennung schlug fehl (Exit ≠ 0, Timeout 2 s, ungültige Antwort) → `stderr_excerpt` im Log-Event `windows_display_helper_failed` prüfen
- **Native Windows display helper spawn failed (code=ENOENT)** / `diagnostics.display.state = helper_missing`: `display-helper.exe` fehlt in `resources/native/display-helper` → Installation unvollständig, Bridge neu installieren
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
- **canon_xc_failed**: Fallback-`errorCode` im Command-Ergebnis, wenn die Kamera-Antwort `ok:false` ist, aber keinen Diagnose-Code liefert (z. B. unerwartete HTTP-Antwort ohne Netzwerkfehler) → `error`/`data.message` und `data.result.response` prüfen; sonst trägt `errorCode` den Canon-Diagnose-Code aus dieser Liste (`timeout`, `connection_refused`, …)

## Desktop
- **Port already in use**: Bridge kann Port nicht binden (Health‑Check Fehler)
- **Bridge not reachable**: Bridge läuft nicht oder falscher Host
- **Engine not connected**: Engine‑Aktionen vor Connect

## Relay
- **command_result success=false**: Fehler im CommandRouter oder Validation
- **WebSocket error: self signed certificate in certificate chain (code: SELF_SIGNED_CERT_IN_CHAIN)** (auch `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, `DEPTH_ZERO_SELF_SIGNED_CERT`): Firmen-Firewall/Proxy signiert die Relay-Verbindung mit eigener Root-CA (TLS-Inspection) → Root-CA muss im OS-Zertifikatspeicher liegen (Bridge lädt ihn mit `NODE_USE_SYSTEM_CA=1`), alternativ `NODE_EXTRA_CA_CERTS` oder Relay-Host von der Inspection ausnehmen; Runbook `docs/bridge/support/relay-tls-trust-runbook.md`
- **WebSocket error … (code: CERT_HAS_EXPIRED / CERT_NOT_YET_VALID / ERR_TLS_CERT_ALTNAME_INVALID)**: Zertifikat ungültig → Systemuhr und Proxy-Konfiguration prüfen
- **Disconnected from relay server (code: 1006)** direkt nach `WebSocket error`: Folge des Handshake-Fehlers, Ursache steht in der Fehlerzeile davor
- **[RuntimeDiagnostics] TLS trust store {…"systemCaEnabled":false…}**: OS-Zertifikatspeicher nicht aktiv (alte Version oder `NODE_USE_SYSTEM_CA` extern auf anderen Wert gesetzt)
