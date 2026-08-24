# Security- und Remote-Control-Transparenz — broadify Bridge

Stand: 24. August 2026 · Dokumentversion 2.0 · Bezugsstand der Software: broadify Bridge v0.25.2

> Dieses Dokument richtet sich an IT-, Sicherheits- und Datenschutzverantwortliche von Kunden. Jede Aussage ist aus dem Quellcode der Version v0.25.2 abgeleitet; Prüfhinweise für eine eigene Verifikation enthält Anhang B. Es ersetzt weder EULA noch AVV noch Datenschutzhinweise. Englische Fassung: `docs/legal/en/security-remote-control-transparency.md`.

## 1. Architektur in einem Absatz

Auf dem Kundenrechner läuft die Desktop-App broadify Bridge. Sie startet einen lokalen Bridge-Prozess und — je nach Funktion — native Helfer (Meeting-Verarbeitung, Grafik-Renderer, Display-/DeckLink-Ausgabe, virtuelle Kamera). Für die Fernsteuerung baut die Bridge **eine einzige ausgehende** WebSocket-Verbindung (WSS) zum broadify-Relay auf; sie öffnet **keinen** aus dem Internet erreichbaren Port. Autorisierte Nutzer der Kundenorganisation senden Kommandos über die WebApp an das Relay; das Relay stellt sie der Bridge zu. Video und Audio werden ausschließlich lokal verarbeitet und verlassen das Gerät nicht über broadify-Infrastruktur (siehe Datenschutzhinweise, Abschnitt 3).

## 2. Was ein entfernter Akteur maximal kann — und was nicht

### 2.1 Abschließende Kommando-Liste

Die Bridge führt ausschließlich Kommandos aus einer fest einkompilierten, versionierten Liste aus (v0.25.2: 79 Kommandos). Unbekannte Kommandos werden verworfen. Gruppen und maximale Wirkung:

| Gruppe | Kommandos | Maximale Wirkung |
| --- | --- | --- |
| Status/Kopplung | `get_status`, `bridge_pair_validate`, `list_outputs` | Statusdaten lesen; Pairing-Code prüfen; lokale Ausgabegeräte auflisten |
| Bildmischer („Engine") | `engine_connect`, `engine_disconnect`, `engine_get_status`, `engine_get_macros`, `engine_run_macro`, `engine_stop_macro`, `engine_vmix_run_action` (nur Script start/stop), `engine_vmix_ensure_browser_input` | Verbindung zu einem vom Nutzer benannten Mischer (ATEM/vMix/TriCaster) im LAN oder per USB auf-/abbauen; vordefinierte Makros/Skripte starten/stoppen |
| Grafiken | `graphics_configure_outputs`, `graphics_send`, `graphics_update_values`, `graphics_update_layout`, `graphics_remove`, `graphics_remove_preset`, `graphics_test_pattern`, `graphics_list` | Grafik-Vorlagen an den lokalen Renderer übergeben (HTML/CSS wird durch einen Sanitizer geprüft: keine Skripte, keine externen URLs) und über konfigurierte Ausgänge ausgeben |
| Meeting | Kamera (`meeting_camera_*`: list/select/start/stop/open_set/program_select/pip_set/audio_levels/auto_director), Keyer (`meeting_keyer_*`), Programm/Ausgabe (`meeting_program_*`, `meeting_output_configure`, virtuelle Kamera start/stop), Aufnahme (`meeting_recording_*`), Inhalte (`meeting_background_image_fetch`, `meeting_media_*`), `meeting_call_control` | Lokale Kamera-Verarbeitung steuern; Aufnahme in eine lokale MP4-Datei starten/stoppen (Pfad validiert, nur `.mp4`); vom Kunden bereitgestellte Inhalte per HTTPS abrufen (Schutzmechanismen siehe 2.3); Konferenz-App per vordefinierter Tastatur-Aktion stummschalten u. ä. (feste Aktions-Liste, keine freie Eingabe) |
| Konferenz | `conference_display_*`, `conference_director_*` | Display-Ausgabe und Mikrofon-Array-Bildregie steuern |
| Peripherie | `streamdeck_*`, `power_socket_*`, `canon_xc_*` | Stream Deck konfigurieren; gespeicherte Steckdosen-URLs auslösen; Kamera-Presets abrufen |

### 2.2 Was es nicht gibt (Negativliste, verifiziert)

- **Keine Ausführung beliebigen Codes:** kein Shell-/Exec-Kommando; alle Prozessstarts der Software verwenden fest einkompilierte Programme mit festen Argumenten; keine Kommando-Eingabe erreicht eine Shell.
- **Kein beliebiger Dateizugriff:** Schreibzugriffe sind auf das App-Datenverzeichnis und validierte Aufnahmepfade (`.mp4`, absolute Pfade, kein `..`) begrenzt; es existiert kein Kommando, das Dateiinhalte des Geräts an die WebApp liefert; Logs sind nicht fernabrufbar.
- **Keine Bildschirmaufnahme:** es existiert kein Screen-Capture-Kommando; die Software überträgt keinerlei Bilddaten an broadify (auch keine Vorschaubilder).
- **Kein Lauschen aus dem Internet:** alle Server der Software binden an 127.0.0.1 (Loopback); die einzige Internet-Verbindung ist die ausgehende Relay-Verbindung sowie Update-Prüfung, Absturzdiagnose und HTTPS-Inhaltsabruf.
- **Kein Betrieb ohne Nutzer:** kein Autostart, kein Systemdienst, kein Daemon. Alle Prozesse enden mit dem Beenden der App (inkl. Selbstbeendigung verwaister Prozesse). Eine geschlossene App kann keine Kommandos empfangen.

### 2.3 Abruf von Kundeninhalten (einzige remote veranlasste Downloads)

`meeting_background_image_fetch` / `meeting_media_fetch` laden vom Kunden hochgeladene Inhalte über kurzlebige signierte URLs. Schutzmechanismen: nur HTTPS auf Port 443, keine eingebetteten Zugangsdaten, keine IP-Literale, DNS-Auflösung wird gegen private/lokale Adressbereiche geprüft (Schutz vor SSRF/DNS-Rebinding), keine Redirects, Größen- und Zeitlimits, Format-Prüfung per Datei-Signatur (Bilder ≤ 8 MB; PDF/PPTX ≤ 100 MB). Bewusste Grenze: Es gibt keine Host-Allowlist — erreichbar ist jeder öffentliche HTTPS-Host innerhalb dieser Limits.

## 3. Kryptografische Absicherung der Fernsteuerung

1. **Nutzer → WebApp:** Anmeldung am Kundenkonto; jede Kommando-Anfrage durchläuft serverseitig Berechtigungsprüfungen: Organisationszugehörigkeit, Rollenrecht „Geräte steuern" (die Rolle „Viewer" kann grundsätzlich keine Kommandos senden), Plan-/Modusfreischaltung (fail-closed) und die Prüfung, dass die Ziel-Bridge der Organisation zugeordnet ist.
2. **WebApp → Relay:** Die WebApp signiert jede Anfrage serverseitig (Ed25519-„Caller Assertion" mit Nutzer, Organisation, Rolle, Ziel-Bridge, Kommando und Payload-Hash; Gültigkeit 30 Sekunden).
3. **Relay → Bridge:** Jedes zugestellte Kommando trägt eine Ed25519-Signatur mit Metadaten (Ziel-Bridge, Berechtigungs-Scope je Kommando, Ausstellungs-/Ablaufzeit ±60 s, Einmal-ID). Die Bridge verifiziert Signatur, Ziel, Scope und Frische, führt einen Replay-Schutz (Einmal-ID-Cache) und begrenzt Nachrichten auf 2 MB. Erst danach wird die Payload gegen strikte Schemata validiert und ausgeführt.
4. **Bridge → Relay:** Die Bridge authentisiert sich mit einem lokal erzeugten Ed25519-Geräteschlüssel (Challenge-Response); der private Schlüssel verlässt das Gerät nie (Datei mit Rechten 0600). Beim Pairing wird nur der öffentliche Schlüssel registriert.
5. **Kopplung:** 8-stelliger Zufallscode, 10 Minuten gültig, bei jedem Start neu, nur im Arbeitsspeicher; ohne erfolgreiches Pairing ist die Bridge keiner Organisation zugeordnet.

Transport: WSS/HTTPS mit Zertifikatsprüfung über den System-Vertrauensspeicher (kein zusätzliches Pinning). Die Anwendungs-Signaturen (Ed25519) sichern die Kommandos unabhängig vom Transport ab.

## 4. Lokales Vertrauensmodell (wichtig für Mehrbenutzersysteme)

Die lokalen Schnittstellen der Software folgen dem Modell „gleicher Rechner = vertrauenswürdig":

- Lokale Steuer-API (Standard `127.0.0.1:8787`): Zugriffe sind auf Loopback beschränkt; Browser-Zugriffe werden über eine Origin-Allowlist (app.broadify.de, lokale Entwicklungs-Origins) und Host-Header-Prüfung (Schutz vor DNS-Rebinding) begrenzt; Nicht-Loopback-Zugriffe erfordern ein konfiguriertes Token (konstantzeitiger Vergleich) und sind ohne Token gesperrt.
- Vorschau (MJPEG) und der Datenstrom der virtuellen Kamera (Port 18787) sind an Loopback gebunden, aber **ohne zusätzliche Authentisierung**: jeder Prozess desselben Rechners kann sie lesen. Der Grafik-Renderer-Kanal ist zusätzlich token-gesichert.
- Windows: Der Shared-Memory-Ring der virtuellen Kamera trägt eine explizite Zugriffssteuerung (SDDL); Lese-/Schreibzugriff haben der Windows-Kameradienst (LOCAL SERVICE) und angemeldete lokale Nutzer. macOS: Shared Memory mit Rechten 0600; die Kamera-Systemerweiterung ist sandboxed und kann ausschließlich den lokalen Datenstrom lesen.

**Empfehlung:** Auf Systemen mit nicht vertrauenswürdigen lokalen Nutzern (Terminal-Server, geteilte Arbeitsplätze) den Einsatz mit der IT-Sicherheit abstimmen.

## 5. Härtung der Anwendung

- Electron: `contextIsolation: true`, `nodeIntegration: false`, Sandbox aktiv; Renderer ohne Node-Zugriff; schmale, geprüfte Preload-Schnittstelle (feste Methodenliste, Absender-Validierung); externe Links nur http/https über den System-Browser.
- Grafik-Vorlagen (HTML/CSS aus der WebApp) durchlaufen einen Sanitizer: keine Skripte, keine Event-Handler, keine iframes/objects, keine externen Ressourcen; nur registrierte lokale Assets.
- Updates: ausschließlich signierte Releases (Windows: Azure Trusted Signing/Authenticode; macOS: Developer-ID + Notarisierung + Hardened Runtime), SHA-512-verifiziert, Installation nur nach Nutzerbestätigung. Veröffentlichungsberechtigung liegt beim Repository-Zugriff mit CI-Signaturgeheimnissen.
- Native Zugriffe: Kamera/Mikrofon nur über die Berechtigungsdialoge des Betriebssystems; die macOS-Kameraerweiterung erfordert eine explizite Aktivierung durch den Nutzer in den Systemeinstellungen.

## 6. Kontrolle durch den Kunden

- **Aus = aus:** Mit dem Beenden der App enden alle Prozesse und die Relay-Verbindung; es gibt keinen Hintergrunddienst.
- Start/Stopp der Bridge und die Netzwerkbindung sind in der App steuerbar; die Kopplung kann organisationsseitig in der WebApp entfernt werden.
- Update-Prüfung abschaltbar (`BROADIFY_DISABLE_AUTO_UPDATE`).
- Lokale Logs sind in der App einsehbar und löschbar (`logs/bridge.log`, `logs/app.log` im App-Datenverzeichnis; Windows-Kamerakomponente: `%ProgramData%\Broadify\vcam.log`).

## 7. Protokollierung und bekannte Grenzen (ehrliche Offenlegung)

Wir legen die derzeit bekannten Grenzen offen, damit Kunden sie bewerten können:

1. **Kommando-Audit:** In Produktionsbuilds wird die Ausführung einzelner Fernsteuer-Kommandos lokal nur auf Debug-Ebene protokolliert; das Standard-Log enthält Verbindungs-/Fehlerereignisse, aber keinen vollständigen Kommando-Verlauf. Ein lückenloses lokales Audit „welcher Nutzer hat wann welches Kommando ausgeführt" ist in v0.25.2 nicht verfügbar. *(Geplante Verbesserung: Info-Level-Audit-Zeile je Kommando.)*
2. **Vorschau-/Kamera-Datenstrom lokal ungeschützt:** loopback-gebunden, aber ohne Authentisierung gegenüber anderen Prozessen desselben Nutzers (Abschnitt 4).
3. **Inhaltsabruf ohne Host-Allowlist** (Abschnitt 2.3).
4. **Steckdosen-URLs:** vom Kunden gespeicherte Schalt-URLs werden bei Auslösung unverändert per HTTP(S) aufgerufen (bestimmungsgemäß für LAN-Steckdosen); es liegt in der Verantwortung des Kunden, dort keine sensiblen URLs zu hinterlegen.
5. **Statusdaten enthalten Betriebsmetadaten** (Gerätenamen, konfigurierte Mischer-IP im LAN, Installationspfade), sichtbar nur für autorisierte Nutzer der eigenen Organisation.
6. **Kein Zertifikats-Pinning** zum Relay (System-Vertrauensspeicher; kompensiert durch Ende-zu-Ende-Signaturen der Kommandos).
7. Lokale Logs enthalten den Rechnernamen (Logbibliothek-Standard); sie verlassen das Gerät nicht.

## 8. Meldung von Sicherheitslücken

Sicherheitsrelevante Beobachtungen bitte an **[SECURITY_CONTACT_EMAIL]**. **[Responsible-Disclosure-Richtlinie/PGP-Schlüssel referenzieren.]**

---

## Anhang A — Datenflüsse auf einen Blick

| Fluss | Richtung | Inhalt | Schutz |
| --- | --- | --- | --- |
| Bridge → Relay | ausgehend, WSS | Anmeldung (Bridge-ID, Name, Version), Status-/Ereignis-JSON, Kommando-Ergebnisse | TLS, Ed25519-Geräteschlüssel |
| Relay → Bridge | über bestehende WSS | signierte Kommandos (Allowlist) | Ed25519-Signatur, Scope, TTL, Replay-Schutz, 2-MB-Limit, Schema-Validierung |
| Bridge → Kundenspeicher | ausgehend, HTTPS | Abruf signierter Inhalts-URLs | SSRF-Guard, Limits, Formatprüfung |
| Desktop-App → Sentry (EU) | ausgehend, HTTPS | Absturz-/Fehlerdiagnose (ohne Nutzerkonto, ohne Rechnername, ohne Screenshots) | TLS |
| Desktop-App → GitHub | ausgehend, HTTPS | Update-Metadaten/Installer (signiert) | TLS, Signatur-/Hash-Prüfung |
| Video/Audio | **verlässt das Gerät nicht** (lokal: Shared Memory, Loopback) | — | Loopback-Bindung, OS-Zugriffsrechte |

## Anhang B — Prüfhinweise für Kunden-IT

- Quellcode: `github.com/pivotrecruiting/broadify-bridge` (öffentlich); maßgebliche Dateien u. a. `apps/bridge/src/services/relay-command-allowlist.ts` (Kommando-Liste), `relay-command-security.ts` (Signatur-/Replay-Prüfung), `apps/bridge/src/services/meeting/media-download.ts` (Download-Guard), `apps/bridge/src/routes/route-guards.ts` (lokale API-Absicherung).
- Netzwerkverifikation: Nach App-Start zeigt `lsof -nP -iTCP -a -p <PID>` (macOS) bzw. `netstat -ano` (Windows) ausschließlich Loopback-Listener und die eine ausgehende WSS-Verbindung.
- Prozessverifikation: Nach Beenden der App laufen keine broadify-Prozesse weiter; es existieren keine Autostart-Einträge/Dienste.
- Signaturverifikation: Windows `Get-AuthenticodeSignature`, macOS `codesign --verify` / `spctl --assess` gegen die installierte App.
