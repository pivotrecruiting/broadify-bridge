# vMix Integration – Umsetzungsplan

## Ziel

Dieses Dokument beschreibt den vollständigen Umsetzungsplan für eine belastbare vMix-Integration in Broadify über die bestehende Kette:

- Desktop App -> lokale Bridge
- Bridge -> Relay
- Relay -> WebApp/API
- WebApp -> Relay -> Bridge -> vMix

Der Plan basiert auf:

- dem aktuellen Stand in `broadify-bridge-v2`
- dem aktuellen Command-/Relay-/Pairing-Modell in `broadify`
- dem aktuellen Delivery-/Auth-/Resume-Modell in `broadify-relay`
- öffentlicher vMix-Dokumentation zu HTTP API, TCP API, Activators und Web-Controller-Security

## Zusammenfassung des Ist-Stands

### Bereits vorhanden

- Die Bridge besitzt einen vMix-Adapter, der per HTTP verbindet, Makros lädt und Makros starten/stoppen kann.
- Die Bridge ist bereits sauber in das Relay-Modell integriert:
  - signierte Relay-Commands
  - `command_received`
  - `command_result`
  - Dedupe
  - Reconnect
  - Resync-Snapshots
- Die WebApp unterstützt im Engine-UI bereits `vmix` als Engine-Typ inklusive Standardport `8088`.
- Die WebApp nutzt für Graphics bereits Relay-WebSocket-Events und hat damit ein funktionierendes Vorbild für Live-Updates.

### Hauptlücken

- Die Bridge modelliert vMix aktuell nur als Macro-Quelle, nicht als vollständige Engine.
- Realtime-State aus vMix wird nicht über TCP-Events, sondern indirekt über Polling abgebildet.
- Es fehlt ein vollständiges vMix-State-Modell:
  - Inputs
  - Preview
  - Program
  - Overlays
  - Tally
  - Recording
  - Streaming
  - External
  - Mix-spezifischer Zustand
- Es fehlen operator-relevante vMix-Commands jenseits von Makros.
- Die Desktop-App ist beim lokalen Engine-Connect noch faktisch auf ATEM fest verdrahtet.
- Für Engine-Live-Status existiert in der WebApp noch kein Relay-Event-First-Modell wie bei Graphics.

## Geklärter Systemkontext

## Bridge / Relay / WebApp

- Die Desktop-App startet die lokale Bridge, erzeugt Pairing-Daten und aktiviert Relay standardmäßig.
- Die WebApp schickt Commands nicht direkt an die Bridge, sondern an eine Next.js API Route.
- Die Next.js API validiert Session, Org-Kontext und Bridge-Zuordnung.
- Danach wird der Command mit signierter Caller-Assertion an `POST /relay/command` weitergeleitet.
- Das Relay prüft Caller-Assertion, Org-Zugriff und routet dann den signierten Command per WebSocket an die Bridge.
- Die Bridge validiert Signatur, TTL, Replay-Schutz und verarbeitet den Command im `CommandRouter`.
- Nach Disconnect/Reconnect publiziert die Bridge bereits Resync-Snapshots über `bridge_event`.

## vMix

- Für Broadify ist kein separater proprietärer SDK-Pfad nötig, um den Integrationsscope zu erfüllen.
- Die offizielle und produktrelevante Schnittstelle ist API-first:
  - HTTP Web API für Snapshot und Command-Ausführung
  - TCP API für Realtime, Tally, Activators und Event-getriebenen Zustand
- Das kanonische State-Snapshot kommt aus der vMix-XML.
- Input-Referenzen sollten intern GUID-basiert (`key`) sein, nicht nummernbasiert.

## Offene Restunsicherheit

Ein Detail ist weiterhin als Spike zu behandeln:

- Der exakte headless Login-/Session-Flow bei aktivem Passwortschutz des Web Controllers ist in den offiziellen öffentlichen Quellen nicht ausreichend konkret dokumentiert.

Das blockiert die Architektur nicht, muss aber sehr früh praktisch gegen reale vMix-Setups validiert werden.

## Zielbild

Die vMix-Integration soll nach Umsetzung folgende Eigenschaften haben:

- vollständiger, stabiler Connect über Broadify Bridge und Relay
- Event-first statt Polling-first
- sauberes State-Modell für vMix statt Macro-only-Sicht
- strukturierte, allowlist-basierte Commands
- Relay-resumable, reconnect-fähig und resync-sicher
- klare Behandlung von vMix-Security-Modi
- identisches Funktionsmodell für WebApp und Desktop

## Architekturprinzipien

### 1. Snapshot + Stream trennen

- HTTP API ist der Snapshot-/Command-Kanal.
- TCP API ist der Realtime-/Event-Kanal.
- HTTP bleibt Fallback für Reconcile und Resync.

### 2. GUID vor Nummer

- vMix-Inputs werden intern über `key` adressiert.
- Input-Nummern bleiben UI-Hilfe, aber nicht Primärreferenz.

### 3. Kein Raw-Passthrough für externe Commands

- WebApp und Relay bekommen keinen generischen "führe beliebige vMix Function aus"-Pfad.
- Stattdessen werden klar definierte, validierte Commands freigegeben.

### 4. Event-first über bestehendes Relay-Modell

- Engine-Status soll wie Graphics über `bridge_event` publiziert werden.
- Polling bleibt nur als Fallback- und Reconcile-Mechanismus.

### 5. Security-by-Design

- Keine Secrets in Logs.
- Keine stillen Downgrades.
- Security-/Auth-Modi müssen als strukturierte Fehler sichtbar sein.

## Phasenplan

## Phase 0 – Scope, Validierung, Spikes

Ziel:
Produktionsscope, vMix-Kompatibilität und kritische Unklarheiten vor Implementierung absichern.

### Deliverables

- definierte Broadify-vMix Scope-Matrix
- dokumentierte Mindest-vMix-Version bzw. getestete Zielversionen
- dokumentierter Security-/Auth-Kompatibilitätsstand

### Todos

- [ ] Scope-Matrix für `v1`, `v1.1` und spätere Ausbaustufen festlegen.
- [ ] Festlegen, welche vMix-Funktionen in `v1` zwingend unterstützt werden:
  - [ ] connect
  - [ ] status
  - [ ] macros
  - [ ] inputs
  - [ ] preview/program
  - [ ] overlays
  - [ ] tally
  - [ ] title text/image updates
- [ ] Reale Ziel-vMix-Versionen definieren und dokumentieren.
- [ ] Security-Kompatibilität gegen reale vMix-Setups testen:
  - [ ] ohne Passwortschutz
  - [ ] mit lokalem Software-Bypass
  - [ ] mit LAN-Passwortschutz
  - [ ] mit aktivierter Enhanced Security
- [ ] Headless Auth-/Login-Verhalten in diesen Modi praktisch verifizieren.
- [ ] Ergebnis der Spikes in einer ergänzenden Architektur-Notiz dokumentieren.

### Abnahme

- [ ] Keine produktkritische Architekturentscheidung basiert mehr auf Annahmen.

## Phase 1 – Transport-Layer für vMix

Ziel:
Saubere technische Basis für HTTP- und TCP-Kommunikation schaffen.

### Deliverables

- dedizierter HTTP-Client
- dedizierter TCP-Client
- robuste Fehler- und Timeout-Behandlung

### Todos

- [ ] Eigenes Modul `vmix-http-client` einführen.
- [ ] Timeouts, Redirect-Handling und Fehlernormalisierung definieren.
- [ ] Optionalen Auth-/Cookie-Support nur aufnehmen, wenn der Spike ihn bestätigt.
- [ ] Eigenes Modul `vmix-tcp-client` einführen.
- [ ] TCP Framing und Line-Parsing robust implementieren.
- [ ] Bounded buffer handling für eingehende Daten implementieren.
- [ ] TCP reconnect/liveness/backoff sauber kapseln.
- [ ] Unterstützung für diese TCP-Befehle implementieren:
  - [ ] `SUBSCRIBE`
  - [ ] `UNSUBSCRIBE`
  - [ ] `ACTS`
  - [ ] `TALLY`
  - [ ] `XML`
  - [ ] `XMLTEXT`
  - [ ] `FUNCTION`
  - [ ] `QUIT`
- [ ] HTTP- und TCP-Client unabhängig testbar machen.

### Abnahme

- [ ] Bridge kann HTTP-Snapshot und TCP-Event-Stream unabhängig initialisieren und überwachen.

## Phase 2 – Kanonisches vMix-State-Modell

Ziel:
vMix als echte Engine modellieren statt als Macro-Liste.

### Deliverables

- erweitertes Engine-State-Modell
- XML-basierter Parser
- Snapshot- und Delta-Verarbeitung

### Todos

- [ ] `EngineStateT` für vMix erweitern.
- [ ] Neues internes vMix-State-Modell definieren mit:
  - [ ] `inputs`
  - [ ] `inputMapByKey`
  - [ ] `preview`
  - [ ] `active`
  - [ ] `overlays`
  - [ ] `mixes`
  - [ ] `recording`
  - [ ] `streaming`
  - [ ] `external`
  - [ ] `fadeToBlack`
  - [ ] `macros`
  - [ ] `lastSeen`
  - [ ] `stateFreshness`
- [ ] XML-Parser für `/api` implementieren.
- [ ] Inputs GUID-basiert (`key`) normalisieren.
- [ ] Input-Nummer und Input-Name als sekundäre Referenzen mappen.
- [ ] Makros aus XML robust parsen.
- [ ] Parser nicht auf Regex-only-Basis für den Vollzustand belassen.
- [ ] Zustandstypen erweitern:
  - [ ] `connected`
  - [ ] `reconnecting`
  - [ ] `degraded`
  - [ ] `stale`
  - [ ] `error`
- [ ] HTTP-Resync nach Connect und nach TCP-Reconnect implementieren.

### Abnahme

- [ ] Ein vMix-Snapshot kann vollständig und deterministisch in internes State-Modell überführt werden.

## Phase 3 – Event- und Realtime-Modell

Ziel:
Echte Realtime-Integration über TCP und Relay-Events.

### Deliverables

- TCP-basierte State-Änderungen
- Engine-Events über Bridge und Relay
- Event-first WebApp-Verbrauch

### Todos

- [ ] TCP `ACTS` und `TALLY` in Bridge-State-Änderungen übersetzen.
- [ ] Event-Mapping definieren:
  - [ ] Activator -> Input-/Overlay-/Runtime-State
  - [ ] Tally -> Preview/Program-Zustand
- [ ] Bridge-seitig neue Engine-Events über `publishBridgeEvent` publizieren.
- [ ] Eventtypen definieren:
  - [ ] `engine_status`
  - [ ] `engine_inputs`
  - [ ] `engine_macros`
  - [ ] `engine_tally`
  - [ ] `engine_error`
- [ ] Resync-Snapshots in der Bridge erweitern.
- [ ] Relay muss dafür nicht neu erfunden werden, aber Event-Nutzung dokumentieren.
- [ ] WebApp-Hook `use-relay-engine-updates` ergänzen.
- [ ] WebApp-Store für Engine auf Event-first umstellen.
- [ ] Polling nur noch als Fallback/Reconcile behalten.

### Abnahme

- [ ] Engine-Status in der WebApp aktualisiert sich live ohne reines Status-Polling.

## Phase 4 – Command-Layer und öffentliche Bridge-Kommandos

Ziel:
vMix-Funktionen kontrolliert und produktgeeignet über Broadify zugänglich machen.

### Deliverables

- erweiterter Command-Katalog
- validierte Payload-Schemas
- keine unsicheren Raw-Kommandos

### Todos

- [ ] Bestehende Engine-Commands beibehalten und auf neues State-Modell anpassen.
- [ ] Neue generische Engine-Commands definieren:
  - [ ] `engine_list_inputs`
  - [ ] `engine_preview_input`
  - [ ] `engine_take_input`
  - [ ] `engine_get_tally`
- [ ] vMix-spezifische Commands mit eigener Allowlist definieren:
  - [ ] `vmix_overlay_in`
  - [ ] `vmix_overlay_out`
  - [ ] `vmix_set_text`
  - [ ] `vmix_set_image`
  - [ ] `vmix_get_title_fields`
  - [ ] `vmix_get_activators`
- [ ] Keine generische Raw-Function-Bridge für WebApp oder Relay freigeben.
- [ ] Input-Referenzschema definieren:
  - [ ] bevorzugt `inputKey`
  - [ ] optional `inputNumber`
  - [ ] optional `inputName`
- [ ] Fehlerstrukturen erweitern:
  - [ ] Auth/Security blockiert
  - [ ] unsupported command
  - [ ] invalid input reference
  - [ ] stale state
  - [ ] device unreachable

### Abnahme

- [ ] Alle neuen Commands sind schemavalidiert, allowlisted und Relay-kompatibel.

## Phase 5 – Bridge-Adapter und Engine-Service refactoren

Ziel:
Den aktuellen vMix-Adapter von Macro-only auf vollständige Engine umbauen.

### Deliverables

- neuer vMix-Adapter mit Snapshot + Stream
- verbesserter Engine-Service
- saubere Disconnect-/Reconnect-Strategie

### Todos

- [ ] `VmixAdapter` in Transport, Parser, State-Assembler und Command-Layer aufteilen.
- [ ] Connect-Sequenz neu definieren:
  - [ ] HTTP reachability
  - [ ] initial XML snapshot
  - [ ] TCP connect
  - [ ] subscribe
  - [ ] state publish
- [ ] Disconnect-Sequenz robust machen.
- [ ] Reconnect-Backoff für TCP integrieren.
- [ ] Bei Stream-Ausfall auf `degraded` statt sofort auf inkonsistentem `connected` bleiben.
- [ ] Bei längerer Inaktivität `stale` markieren.
- [ ] Nach erfolgreichem Reconnect Snapshot-Reconcile ausführen.
- [ ] Engine-Service auf neue Zustandsfelder erweitern.
- [ ] WebSocket-/Bridge-interne Event-Broadcasts daran anpassen.

### Abnahme

- [ ] Reconnect erzeugt keinen doppelten Side-Effect und keinen still veralteten Zustand.

## Phase 6 – WebApp-Integration

Ziel:
Die bereits vorhandene WebApp-vMix-Unterstützung funktional vervollständigen.

### Deliverables

- vollständige Engine-UI
- Live-Status
- erweiterte Operator-Flows

### Todos

- [ ] Bestehende vMix-Auswahl in der WebApp beibehalten und an neues Modell anschließen.
- [ ] Engine-Store auf erweitertes State-Modell umbauen.
- [ ] Input-Liste im UI darstellen.
- [ ] Preview- und Program-Zustand sichtbar machen.
- [ ] Overlay-Zustände sichtbar machen.
- [ ] Tally-Indikatoren darstellen.
- [ ] Title-/Text-/Image-Aktionen produktiv anschließen.
- [ ] Controls-/Macro-Bereich an Live-Engine-Events anbinden.
- [ ] Event-first Hook für Engine analog zu `use-relay-graphics-updates` integrieren.
- [ ] Polling reduzieren und nur als Fallback behalten.

### Abnahme

- [ ] Die WebApp kann vMix als Live-Engine bedienen, nicht nur Makros auslösen.

## Phase 7 – Desktop-App-Parität

Ziel:
Die lokale Desktop-App auf denselben vMix-Funktionsstand bringen.

### Deliverables

- Desktop-UI mit vMix-Auswahl
- korrekter lokaler Connect-Flow
- konsistente Statusanzeige

### Todos

- [ ] IPC-Connect-Contract von ATEM-Fixierung lösen.
- [ ] Desktop-UI auf `atem`, `tricaster`, `vmix` erweitern.
- [ ] Standardports sauber setzen:
  - [ ] `9910` für ATEM
  - [ ] `8080` für Tricaster
  - [ ] `8088` für vMix HTTP
- [ ] Später optional TCP-Port-Konfiguration oder implizite Nutzung dokumentieren.
- [ ] Desktop-Hooks nicht mehr rein polling-basiert halten.
- [ ] Wo sinnvoll lokale Bridge-WebSocket-Events nutzen.
- [ ] UX-Fehlertexte für vMix-Security-Modi ergänzen.

### Abnahme

- [ ] Desktop und WebApp verhalten sich für vMix konsistent.

## Phase 8 – Security, Betrieb und Doku

Ziel:
Die Integration produktionsreif, supportbar und nachvollziehbar machen.

### Deliverables

- aktualisierte Security-Doku
- aktualisierte Architektur-Doku
- klares Betriebsmodell

### Todos

- [ ] Unterstützte vMix-Betriebsmodi dokumentieren:
  - [ ] local same machine
  - [ ] LAN same subnet
  - [ ] VLAN/VPN mit kontrollierter Konnektivität
- [ ] Nicht unterstützte oder riskante Modi explizit dokumentieren.
- [ ] Security-Auswirkungen von Engine-Commands dokumentieren.
- [ ] Logging-Regeln für vMix ergänzen:
  - [ ] keine Credentials
  - [ ] keine Session-Secrets
  - [ ] keine unmaskierten sensiblen Payloads
- [ ] Relay-/Bridge-Doku um neue Engine-Events ergänzen.
- [ ] Pairing-/Bridge-/Relay-Doku nur dort anpassen, wo der neue Engine-Eventpfad relevant ist.
- [ ] Integrationsdoku und QA-Checklisten aktualisieren.

### Abnahme

- [ ] Doku entspricht nach Umsetzung dem tatsächlichen Code- und Betriebsstand.

## Phase 9 – Teststrategie und Abnahme

Ziel:
Funktionalität, Reconnect-Verhalten und Security robust verifizieren.

### Deliverables

- Unit-Tests
- Integrationstests
- E2E-Tests
- manuelles Runbook

### Todos

- [ ] Unit-Tests für XML-Parser ergänzen.
- [ ] Unit-Tests für TCP-Parser ergänzen.
- [ ] Unit-Tests für Activator-/Tally-Mapping ergänzen.
- [ ] Contract-Tests für HTTP- und TCP-Nachrichten ergänzen.
- [ ] Bridge-Integrationstests mit Mock-vMix einführen.
- [ ] Relay-Reconnect-/Replay-/Resync-Tests für Engine-State ergänzen.
- [ ] WebApp-E2E-Tests ergänzen:
  - [ ] Engine connect
  - [ ] Engine reconnect
  - [ ] Live status
  - [ ] macro run
  - [ ] preview/program
  - [ ] overlay toggle
  - [ ] set text
  - [ ] set image
- [ ] Manuelles Test-Runbook für echte vMix-Systeme dokumentieren.

### Abnahme

- [ ] Die vMix-Integration ist gegen reale und simulierte Fehlerbilder abgesichert.

## Priorisierte Implementierungsreihenfolge

Wenn nicht alles parallel umgesetzt wird, ist diese Reihenfolge empfohlen:

1. Phase 0
2. Phase 1
3. Phase 2
4. Phase 5
5. Phase 3
6. Phase 4
7. Phase 6
8. Phase 7
9. Phase 8
10. Phase 9

## Risiken

### Technische Risiken

- TCP-Event-Semantik muss gegen echte vMix-Instanzen verifiziert werden.
- Security-/Login-Verhalten kann je nach vMix-Konfiguration Unterschiede haben.
- XML-State kann versionsabhängig leicht variieren.
- Title-/Field-Namen sind projektspezifisch und müssen stabil referenzierbar gemacht werden.

### Produkt- und Betriebsrisiken

- Ein zu offener Command-Scope würde unnötige Sicherheits- und Supportkosten erzeugen.
- Reines Polling würde die vorhandene Relay-Echtzeitarchitektur unter Wert nutzen.
- Nummernbasierte Input-Referenzen würden zu fragilen Automationen führen.

## Abschlusskriterien

Die vMix-Integration gilt als produktionsreif, wenn alle folgenden Punkte erfüllt sind:

- [ ] Broadify kann vMix über Bridge und Relay stabil verbinden.
- [ ] Engine-State ist live, korrekt und reconnect-fähig.
- [ ] Reconnect erzeugt keinen doppelten Side-Effect.
- [ ] WebApp nutzt Engine-Events event-first.
- [ ] Desktop-App unterstützt vMix konsistent.
- [ ] Security-Modi werden korrekt erkannt und verständlich kommuniziert.
- [ ] Alle freigegebenen Commands sind allowlisted und validiert.
- [ ] Doku, Tests und Betriebswissen sind aktualisiert.

## Relevante interne Referenzen

- Bridge Relay-Protokoll: `docs/bridge/features/relay-protocol.md`
- Bridge Relay-Architektur: `docs/bridge/architecture/relay-enterprise-architecture.md`
- Bridge Relay-Client: `apps/bridge/src/services/relay-client.ts`
- Bridge Command Router: `apps/bridge/src/services/command-router.ts`
- Bridge vMix Adapter: `apps/bridge/src/services/engine/adapters/vmix-adapter.ts`
- WebApp Command API: `broadify/app/api/bridges/[bridgeId]/command/route.ts`
- WebApp Pairing API: `broadify/app/api/bridges/pair/route.ts`
- WebApp Engine UI: `broadify/app/(pages)/(with-nav)/dashboard/components/engine-section.tsx`
- WebApp Graphics Live Updates: `broadify/hooks/use-relay-graphics-updates.ts`
- Relay Server: `broadify-relay/src/index.ts`

## Öffentliche vMix-Quellen

- Developer Information: `https://www.vmix.com/help26/DeveloperInformation.html`
- Developer API: `https://www.vmix.com/help29/DeveloperAPI.html`
- TCP API: `https://www.vmix.com/help27/TCPAPI.html`
- Web Scripting: `https://www.vmix.com/help28/WebScripting.html`
- Activators: `https://www.vmix.com/help28/ActivatorsEdit.html`
- Web Controller / User Guide: `https://www.vmix.com/help29/vMixUserGuide.pdf`
