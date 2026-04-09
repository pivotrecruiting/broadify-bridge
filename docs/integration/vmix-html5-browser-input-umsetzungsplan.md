# vMix HTML5 Browser Input – Umsetzungsplan

## Ziel

Dieser Plan beschreibt den Zielpfad fuer `v1` der vMix-Integration mit folgendem Architekturmodell:

- Broadify WebApp und Bridge laufen auf einem Laptop
- Die Bridge verbindet sich mit vMix
- Die WebApp nutzt Broadify Controls und Graphics
- vMix wird als Mischer verwendet
- Broadify nutzt **nicht** das native vMix-Grafiksystem
- Broadify sendet in `v1` **keine Video-/NDI-Streams**
- Stattdessen rendert vMix eine Broadify-HTML5-Grafikseite als `Web Browser Input`

Kurz:

- Controls/Makros/Funktionen -> Bridge steuert vMix per API
- Graphics -> vMix laedt Broadify HTML im Browser Input und rendert diese Seite selbst

## Bestaetigtes Zielbild

Die gewuenschte `v1`-Topologie ist:

1. Ein Laptop betreibt:
   - WebApp
   - Bridge
   - optional vMix auf derselben Maschine oder im LAN auf einem anderen Rechner
2. Die WebApp sendet Commands ueber den bestehenden Broadify-Pfad:
   - WebApp -> Next.js API
   - Next.js API -> Relay
   - Relay -> Bridge
   - Bridge -> vMix
3. Die Bridge verbindet sich mit vMix fuer:
   - Status
   - Makros
   - Funktionen
   - Input-/Preview-/Program-State
4. Die Graphics Section rendert **nicht** in Broadify zu einem Video-Output fuer vMix.
5. Stattdessen stellt Broadify eine HTML5-Grafik-URL bereit.
6. vMix laedt diese URL in einem `Web Browser Input`.
7. vMix rendert diese Seite lokal im Browser Input und mischt sie aus.
8. Auf Basis des aktuellen Code-Stands sollte diese URL in `v1` primaer von der **Bridge** lokal ausgeliefert werden, nicht von einer authentifizierten Dashboard-Seite der WebApp.

## Wichtige technische Klarstellung

Im bestaetigten `v1`-Modell gilt:

- Broadify rendert **nicht** selbst final in Video-Frames fuer vMix
- vMix rendert die HTML-Seite im eigenen Browser Input
- Broadify liefert:
  - HTML
  - CSS
  - Assets
  - Daten
  - Zustandsupdates
- Die WebApp bleibt primaer fuer Authoring, Controls und Command-Ingress zustaendig.
- Die Bridge ist fuer `v1` der naheliegende Auslieferungsort fuer die Browser-Input-Seite und deren Laufzeit-Zustand.

Das ist fuer `v1` einfacher und passt zum gewuenschten Flow.

## Was dieses v1 explizit nicht ist

Folgende Modelle sind **nicht** Teil dieses Plans:

- Broadify -> NDI/OMT -> vMix
- Broadify -> Video-Stream mit Alpha -> vMix
- Broadify -> Key/Fill direkt nach vMix
- Nutzung des nativen vMix-Titel-/GT-Systems als primaerer Grafikpfad

Diese Modelle koennen spaeter kommen, sind aber nicht der aktuelle Scope.

## Physischer Aufbau

## Variante A – Empfohlen fuer v1

vMix laeuft auf demselben Laptop wie WebApp und Bridge.

Vorteile:

- einfachster Netzwerkpfad
- Browser-Input kann lokale URL laden
- Bridge kann lokal gegen `127.0.0.1` mit vMix sprechen
- geringste Zahl an Deployment-Variablen

Beispiel:

- Bridge HTTP: `http://127.0.0.1:<bridge-port>`
- Bridge Browser-Input-Page: `http://127.0.0.1:<bridge-port>/graphics/browser-input`
- Bridge Browser-Input-State: `http://127.0.0.1:<bridge-port>/graphics/browser-input/state`
- vMix API: `http://127.0.0.1:8088`
- WebApp: Controls, Authoring und Relay-Commands

## Variante B – Moeglich, aber komplexer

vMix laeuft auf einem anderen Rechner im LAN.

Dann gilt:

- Bridge kann Controls/Makros/Funktionen weiter per LAN-API an vMix senden
- aber die Grafik-URL muss **vom vMix-Rechner aus erreichbar** sein

Das bedeutet:

- `localhost` auf dem Laptop reicht dann fuer den Browser Input nicht
- die Grafikseite muss vom vMix-Rechner aus ueber LAN erreichbar sein
- bei Bridge-hosted Auslieferung muss die Bridge bewusst an eine LAN-Adresse gebunden werden

Fuer `v1` sollte deshalb zuerst Variante A priorisiert werden.

## Ist-Stand im Broadify-System

### Bereits vorhanden

- WebApp -> Next.js API -> Relay -> Bridge ist bereits produktiv vorhanden
- Relay besitzt:
  - signed commands
  - caller assertion
  - pairing-only bootstrap
  - reconnect/resume/resync
- Bridge besitzt bereits Engine-Commands fuer:
  - `engine_connect`
  - `engine_disconnect`
  - `engine_get_status`
  - `engine_get_macros`
  - `engine_run_macro`
  - `engine_stop_macro`
- vMix ist als Engine-Typ bereits im Command-Schema und in der WebApp angelegt
- Die WebApp-Engine-UI unterstuetzt `vmix` bereits explizit inklusive Default-Port `8088`
- Die WebApp-Engine-Store- und Command-Helfer unterstuetzen `vmix` bereits produktiv
- Die WebApp besitzt bereits einen produktiven Relay-WebSocket fuer `graphics_status`
- Die WebApp besitzt bereits eine HTML/CSS-Template-Runtime:
  - `renderTemplateHtml(...)`
  - iframe-basierte Preview-Komponenten
  - vorhandenes `graphics_send`-Bundle mit `manifest/html/css/schema/defaults`

### Noch nicht ausreichend vorhanden

- Die Bridge modelliert vMix aktuell nur sehr schmal
- Die Desktop-App ist lokal noch ATEM-fixiert
- Der bestehende Graphics-Contract ist weiterhin output-/frame-orientiert
- `GraphicsOutputKey` kennt noch keinen `browser_input`-Modus
- `graphics_status` kennt noch keine Browser-Input-Metadaten
- Es gibt in der WebApp aktuell **keine** dedizierte oeffentliche oder tokenisierte Browser-Input-Route
- Die bestehenden Dashboard-/Graphics-Seiten der WebApp sind authentifiziert und damit nicht direkt als vMix-Browser-Input geeignet
- Der bestehende Relay-WebSocket fuer Graphics setzt einen eingeloggten WebApp-User mit Access Token voraus und ist damit kein direkter Feed fuer eine anonyme vMix-Browser-Seite
- Es gibt noch kein Broadify-vMix-HTML5-Handshakemodell
- Es gibt noch keine produktive Verwaltung von vMix Browser Input URLs / Sessions / Input-Referenzen

## Erkenntnisse aus dem aktuellen WebApp- und Relay-Stand

Diese Punkte sind durch den aktuellen Code-Stand bereits belastbar belegt und muessen fuer den Plan nicht mehr als reine Hypothesen behandelt werden:

- Die WebApp kann `vmix` bereits verbinden:
  - Engine UI mit `ATEM`, `Tricaster`, `vMix`
  - Default-Port `8088`
  - persistierte Connection Preferences
- Der Command-Ingress ist bereits produktiv:
  - WebApp -> `app/api/bridges/[bridgeId]/command/route.ts`
  - Next.js API -> Relay `/relay/command`
  - Relay -> Bridge `command`
- Graphics-Statusupdates sind bereits produktiv:
  - Bridge -> Relay `bridge_event`
  - Relay -> WebApp `webapp_subscribe`
  - WebApp konsumiert `graphics_status`
- Der bestehende Graphics-Datenvertrag ist bereits stark ausgepraegt:
  - `graphics_send` transportiert HTML/CSS/Schema/Defaults/Values
  - die WebApp baut Bundle-Payloads bereits deterministisch
  - die Template-Runtime rendert aus Template-Config + Values fertiges HTML
- Die vorhandene WebApp-Preview belegt, dass Broadify-Templates grundsaetzlich in Browser-/iframe-Kontexten laufen koennen
- Die aktuelle WebApp besitzt jedoch keine anonyme, stabile Browser-Input-Seite fuer vMix
- Die aktuelle Relay-Subscription ist fuer authentifizierte WebApp-Clients gedacht, nicht fuer einen anonymen lokalen Browser Input

## Abgeleitete Architekturentscheidung fuer einen implementation-ready v1

Auf Basis des vorhandenen Code-Stands wird fuer `v1` folgende Architekturentscheidung empfohlen und in diesem Plan als Zielbild verwendet:

### 1. Browser-Input-Seite wird primaer von der Bridge ausgeliefert

- Nicht von einer authentifizierten Dashboard-Route der WebApp
- Grund:
  - Dashboard-Seiten sind login-geschuetzt
  - der bestehende Relay-WebSocket verlangt einen User-Access-Token
  - die Bridge hat bereits einen lokalen Fastify-HTTP-Server und ist im same-machine-Setup die einfachste, supportbarste URL-Quelle

### 2. Der bestehende Graphics-Commandpfad bleibt erhalten

- WebApp sendet weiter `graphics_send`, `graphics_update_values`, `graphics_update_layout`, `graphics_remove`, `graphics_remove_preset`
- Die Bridge fuehrt fuer `browser_input` **kein** Video-Frame-Rendering aus
- Stattdessen schreibt die Bridge den Grafikzustand in einen browser-input-faehigen Laufzeit-Store

### 3. `browser_input` wird als eigener Graphics-Output-Modus modelliert

- Nicht als Sonderfall ausserhalb des bestehenden Graphics-Stores
- Empfohlene Erweiterung:
  - `GraphicsOutputKey = "browser_input"`
- Grund:
  - die WebApp ist heute bereits output-key-zentriert modelliert
  - so bleiben bestehende Flows fuer `graphics_configure_outputs` und `graphics_status` wiederverwendbar

### 4. v1 unterstuetzt genau einen Browser Input pro Bridge

- Eine feste URL pro Bridge
- Ein compositeter Broadify-Scene-State pro Bridge
- Die bestehenden Kategorien `lower-thirds`, `overlays`, `slides` werden in dieser einen Browser-Input-Seite zusammengesetzt
- Mehrere dedizierte Browser-Inputs sind `v1.x`

### 5. Zustand fuer die Browser-Seite kommt primaer aus der Bridge selbst

- Initialzustand ueber Bridge-HTTP-Endpoint
- Laufende Updates ueber Bridge-lokalen Polling- oder WebSocket-Pfad
- Wegen Embedded-Browser-Risiko wird Polling als belastbare Baseline fuer `v1` eingeplant; WebSocket kann nach positivem Spike als Optimierung dazukommen

### 6. Remote-vMix im LAN ist nicht Kern von v1

- `v1` wird auf same-machine optimiert
- Remote-vMix wird erst dann aktiv aufgenommen, wenn:
  - die Bridge-URL absichtlich im LAN freigegeben wird
  - das Sicherheitsmodell fuer diesen Pfad definiert ist
  - das Verhalten in realem vMix-LAN-Betrieb validiert wurde

## Zielbild der Funktionen in v1

## Controls Section

Die Controls Section soll in `v1` koennen:

- vMix verbinden / trennen
- Makros laden
- Makros ausloesen
- Status lesen
- spaeter in derselben Linie:
  - Preview/Program lesen
  - Input-Liste lesen
  - Overlay-Zustand lesen

## Graphics Section

Die Graphics Section soll in `v1` koennen:

- einen `browser_input`-Modus konfigurieren
- eine feste Bridge-URL fuer einen vMix Browser Input bereitstellen
- den bestehenden Broadify-Grafikzustand in eine browser-input-faehige Laufzeit schreiben
- diese Seite mit Daten versorgen
- Grafikupdates auf dieser Seite sichtbar machen
- vMix mischt den Browser Input dann wie jeden anderen Input

Optional fuer spaeteres `v1.x`:

- Browser Input automatisch in vMix anlegen / konfigurieren
- mehrere Grafikseiten / mehrere Inputs
- Status ruecklesen, ob Browser Input erreichbar oder aktiv ist

## Architekturelle Grundentscheidung

### Primaerer Pfad fuer Controls

- Bridge -> vMix API

### Primaerer Pfad fuer Graphics

- vMix Browser Input -> Broadify HTML5 URL

### Nicht primaer in v1

- Bridge -> vMix fuer Grafik-Frame-Streaming

## Hauptfragen, die fuer v1 bereits geklaert sind

- Der Flow ist technisch sinnvoll.
- Es gibt kein grundlegendes Missverstaendnis im physischen Aufbau.
- Der Browser-Input-Ansatz ist fuer `v1` bewusst akzeptiert.
- vMix ist in diesem Modell:
  - API-gesteuerte Engine fuer Controls
  - Browser-Renderer fuer Graphics
  - Mischer fuer das Endsignal

## Restfragen, die als fruehe Spikes behandelt werden muessen

- Wie robust verhaelt sich der vMix Browser Input mit Broadify-HTML/CSS/Fonts/Assets im Produktionsbetrieb?
- Reicht fuer `v1` ein lokaler Polling-Endpoint fuer Updates aus, oder ist WebSocket im vMix-Browser stabil genug fuer den Produktbetrieb?
- Soll die Bridge fuer `v1` nur eine feste Browser-Input-URL dokumentieren oder zusaetzlich Konfigurationsmetadaten wie "empfohlener Input-Name" und "letzter Handshake" fuehren?
- Soll die vorhandene WebApp-Renderlogik spaeter in ein Shared Package extrahiert werden, oder darf `v1` zunaechst eine Bridge-seitige, eng am bestehenden Render-Contract orientierte Runtime besitzen?

## Architekturregeln fuer v1

### 1. vMix bleibt Mischer, nicht Grafikquelle

- Keine Nutzung des nativen vMix-Titel-/GT-Systems als primaerer Broadify-Grafikpfad
- Keine Broadify-Templates in vMix-Title-Projekten nachbauen

### 2. Browser Input ist ein expliziter Integrationsmodus

- HTML5-Rendering ueber Browser Input ist der definierte `v1`-Modus
- Der Browser Input ist kein Workaround, sondern bewusstes Produktverhalten fuer `v1`
- Technisch wird dieser Modus in `v1` als eigener Graphics-Output-Modus `browser_input` modelliert

### 3. Controls und Graphics sind getrennte Integrationspfade

- Controls laufen ueber vMix API
- Graphics laufen ueber Browser Input URL
- Beide Pfade sollen in UI und Code getrennt modelliert werden

### 4. Lokaler Single-Machine-Pfad zuerst

- `v1` soll zuerst fuer `WebApp + Bridge + vMix auf einem Laptop` sauber funktionieren
- LAN-Remote-vMix ist nachrangig
- Die primaere Browser-Input-URL kommt in `v1` von der lokal laufenden Bridge

### 5. Kein stiller Mischbetrieb

- Die UI muss klar anzeigen:
  - Engine verbunden?
  - Browser-Input-URL bereit?
  - Grafikseite erreichbar?
  - Browser-Input in vMix konfiguriert?

## Phasenplan

## Phase 0 – Scope-Fixierung und technische Spikes

Ziel:
Das bestaetigte Browser-Input-Modell verbindlich machen und alle kritischen Entscheidungen vor Implementierung absichern.

### Bereits festgezurrte Entscheidungen

- `v1` ist offiziell ein `HTML5 Browser Input`-Modus
- `Broadify rendert Stream nach vMix` ist explizit **nicht** `v1`
- Standard-Betriebsmodus ist:
  - same machine first
  - LAN spaeter
- `v1` unterstuetzt genau **einen** Browser Input pro Bridge
- Die primaere Browser-Input-Seite wird in `v1` durch die Bridge ausgeliefert

### Todos

- [ ] Reale vMix-Browser-Input-Spikes durchfuehren:
  - [ ] lokale Bridge-URL laden
  - [ ] Transparenz pruefen
  - [ ] Font-Laden pruefen
  - [ ] CSS-/Animation-Verhalten pruefen
  - [ ] Resize-/Aspect-Verhalten pruefen
  - [ ] Polling-basierte Datenupdates pruefen
  - [ ] optional WebSocket-Verhalten pruefen
- [ ] Browser-Input-URL-Schema final auf konkrete Pfade festlegen
- [ ] Bridge-seitigen Browser-Input-State-Store definieren

### Abnahme

- [ ] Alle v1-Architekturentscheidungen fuer Browser Input sind explizit dokumentiert.

## Phase 1 – vMix Controls sauber aufbauen

Ziel:
Die Bridge soll vMix fuer Controls robust anbinden.

### Todos

- [ ] vMix-Adapter auf produktiven Stand fuer `v1` bringen.
- [ ] HTTP-Client fuer vMix API sauber kapseln.
- [ ] Verbindungsfehler normalisieren.
- [ ] vMix-Statusmodell erweitern fuer:
  - [ ] connected/disconnected/error
  - [ ] IP/Port
  - [ ] Makros
  - [ ] optional Preview/Program/Input-Liste
- [ ] Makro-Handling fuer vMix robust absichern.
- [ ] Bestehende WebApp-Fehler- und Polling-Erwartungen gegen den finalen vMix-Adapter pruefen
- [ ] Optional fuer `v1.x`:
  - [ ] Input-Liste lesen
  - [ ] Preview/Program lesen
  - [ ] Overlay-State lesen

### Abnahme

- [ ] Bridge kann vMix verbinden, Makros laden und Makros ausloesen.

## Phase 2 – Browser-Input Grafikmodus definieren

Ziel:
Die Broadify-Graphics muessen als HTML5-Seite fuer vMix Browser Input konsumierbar werden.

### Todos

- [ ] `browser_input` als neuen Graphics-Output-Modus in Bridge- und WebApp-Typen einfuehren.
- [ ] URL-Konzept finalisieren.
- [ ] Standard-Routen fuer Browser-Input-Grafiken definieren.
- [ ] Eine stabile HTML-Seite fuer vMix Browser Input in der Bridge bereitstellen.
- [ ] Die Seite muss Broadify-Graphics rendern koennen.
- [ ] Transparenter Hintergrund muss sauber unterstuetzt werden.
- [ ] Asset-Ladeverhalten fuer Fonts/Bilder/CSS stabilisieren.
- [ ] Caching-Verhalten definieren.
- [ ] Reload-/Recover-Verhalten definieren.

### Konkretisierung fuer v1

- Eine feste URL pro Bridge
- Kein URL-Modell pro Grafikslot
- Keine Session-Parameter als Pflichtbestandteil fuer den Normalfall

### Abnahme

- [ ] vMix kann die Broadify-Grafikseite als Browser Input laden und sichtbar rendern.

## Phase 3 – Daten- und Zustandsmodell fuer Browser-Input-Grafiken

Ziel:
Die Graphics Section muss der Browser-Input-Seite Daten und Zustand liefern koennen.

### Todos

- [ ] Definieren, wie die Browser-Input-Seite ihren Zustand erhaelt:
  - [ ] initial snapshot endpoint
  - [ ] polling endpoint als Mindestpfad
  - [ ] optional websocket/realtime nach Spike
- [ ] Ein dediziertes Browser-Input-State-Modell in der Bridge definieren.
- [ ] Bestehende `graphics_*`-Commands an diesen Modus anbinden.
- [ ] Update-Flows fuer:
  - [ ] initial render
  - [ ] text/value updates
  - [ ] layout updates
  - [ ] remove/reset
  - [ ] preset activation/deactivation
- [ ] Fehlerfall modellieren:
  - [ ] Seite nicht erreichbar
  - [ ] Assets fehlen
  - [ ] Grafikdaten ungueltig
  - [ ] State-Store leer oder inkonsistent
- [ ] Sichtbar machen, ob die Browser-Input-Seite einen gueltigen Zustand hat.

### Abnahme

- [ ] Broadify kann Grafikdaten an eine Browser-Input-Seite uebergeben und diese aktualisieren.

## Phase 4 – WebApp UX fuer vMix Browser Input

Ziel:
Die WebApp soll klar und produktiv mit dem Browser-Input-Modell umgehen koennen.

### Todos

- [ ] Bestehende Engine-UI fuer `vmix` nur noch gegen den finalen Bridge-Vertrag verifizieren.
- [ ] In der Graphics Section einen `vMix Browser Input`-Modus sichtbar machen.
- [ ] Dem Nutzer die benoetigte Browser-Input-URL anzeigen.
- [ ] Optional Copy/Launch-Helfer fuer die URL anbieten.
- [ ] Klare Statusanzeigen einfuehren:
  - [ ] vMix verbunden
  - [ ] Browser-Input-Mode aktiv
  - [ ] Grafikseite bereit
  - [ ] Browser-Input-URL vorhanden
  - [ ] letzter Browser-Input-Handshake / letzte Aktivitaet
- [ ] UX-Texte fuer same-machine und remote-vMix unterscheiden.
- [ ] Dokumentieren, was der Operator in vMix tun muss:
  - [ ] Browser Input anlegen
  - [ ] URL eintragen
  - [ ] Transparenz / Layering korrekt konfigurieren

### Abnahme

- [ ] Ein Operator kann ohne Rateversuche den Browser-Input-Flow einrichten.

## Phase 5 – Bridge-/Relay-/WebApp-Zusammenspiel fuer Graphics

Ziel:
Graphics muessen innerhalb der bestehenden Broadify-Architektur sauber transportiert werden.

### Todos

- [ ] Bestehenden Graphics-Commandpfad weiterverwenden.
- [ ] `graphics_configure_outputs` und Status-Typen um `browser_input` erweitern.
- [ ] Sicherstellen, dass Relay/Bridge fuer diesen Modus keine Video-Output-Annahmen treffen.
- [ ] `graphics_status` fuer Browser-Input-Metadaten erweitern:
  - [ ] browserInputUrl
  - [ ] mode
  - [ ] lastBrowserClientSeenAt
  - [ ] stateVersion oder vergleichbares Sync-Signal
- [ ] Das Zusammenspiel mit bestehendem GraphicsStore sauber dokumentieren.

### Abnahme

- [ ] Graphics Commands der WebApp koennen Browser-Input-Grafiken ueber die bestehende Broadify-Kette verwalten.

## Phase 6 – Optionaler API-Komfort fuer Browser Input

Ziel:
Den manuellen Aufwand in vMix reduzieren, ohne `v1` zu blockieren.

### Todos

- [ ] Pruefen, ob vMix Browser Inputs per API sinnvoll referenziert oder automatisiert konfiguriert werden koennen.
- [ ] Falls praktikabel:
  - [ ] Input-Pruefung gegen URL/Name
  - [ ] Input-Findung anhand konfigurierter Namen
  - [ ] Hilfsfunktionen fuer Operator-Setup
- [ ] Wenn API-seitig zu fragil:
  - [ ] klar dokumentieren, dass Browser Input in `v1` manuell angelegt wird

### Abnahme

- [ ] Es ist klar entschieden, ob Browser Input Setup manuell oder teilautomatisiert erfolgt.

## Phase 7 – Desktop-App-Paritaet

Ziel:
Die Desktop-App soll den gleichen lokalen vMix-Flow verstehen.

### Todos

- [ ] Engine-Typ in der Desktop-App fuer `vmix` freigeben.
- [ ] Desktop-Connect-Contract von ATEM-Fixierung loesen.
- [ ] Standardport `8088` fuer vMix hinterlegen.
- [ ] Lokale Hinweise fuer Browser-Input-URL im Desktop-Kontext bereitstellen, falls gewuenscht.
- [ ] Sicherstellen, dass die lokale Desktop-App den same-machine Browser-Input-Flow unterstuetzt.

Hinweis:

- Die **WebApp** ist an dieser Stelle bereits weiter als die Desktop-App; der offene Paritaetsbedarf betrifft vor allem Electron/Desktop, nicht mehr die WebApp.

### Abnahme

- [ ] Der lokale Laptop-Flow funktioniert sowohl aus der WebApp als auch aus der Desktop-App nachvollziehbar.

## Phase 8 – Security und Betriebsmodell

Ziel:
Der Browser-Input-Ansatz muss supportbar und sicher genug fuer den Zielbetrieb sein.

### Todos

- [ ] URL-Sicherheitsmodell definieren.
- [ ] `v1` explizit als same-machine first dokumentieren.
- [ ] Falls Browser-Input-URL im LAN erreichbar sein soll:
  - [ ] lokalen vs. LAN-Bind sauber spezifizieren
  - [ ] Remote-vMix fuer `v1` nur bei bewusst aktivierter LAN-Exposition erlauben
- [ ] Logging-Regeln definieren:
  - [ ] keine sensiblen Payloads
  - [ ] keine Secrets in Browser-Input-URLs
  - [ ] Browser-Input-Handshake nur als Meta-Info loggen
- [ ] Security-Doku fuer diesen Modus aktualisieren.

### Abnahme

- [ ] Das Betriebsmodell fuer Browser-Input-Grafiken ist klar dokumentiert.

## Phase 9 – Teststrategie

Ziel:
Der Browser-Input-Flow muss auf realer Maschine reproduzierbar funktionieren.

### Todos

- [ ] Unit-Tests fuer vMix-Control-Pfade erweitern.
- [ ] Integrationstests fuer Browser-Input-URL-Generierung schreiben.
- [ ] Tests fuer Graphics-Datenmodell im Browser-Input-Modus schreiben.
- [ ] Manuelles QA-Runbook erstellen:
  - [ ] vMix lokal auf Laptop
  - [ ] Browser Input anlegen
  - [ ] URL laden
  - [ ] Grafik sichtbar
  - [ ] Grafikupdate sichtbar
  - [ ] Makro aus Controls ausloesbar
  - [ ] Browser-Input-Neuladen ohne Zustandverlust oder mit definiertem Recover-Verhalten
- [ ] Optional Remote-vMix-LAN-Runbook erstellen.

### Abnahme

- [ ] Ein kompletter Demo-Flow ist ohne Ad-hoc-Bastelei reproduzierbar.

## Priorisierte Umsetzung

Empfohlene Reihenfolge:

1. Phase 0
2. Phase 1
3. Phase 2
4. Phase 3
5. Phase 4
6. Phase 5
7. Phase 7
8. Phase 8
9. Phase 9
10. Phase 6

## Minimaler v1-Deliverable-Scope

`v1` ist erreicht, wenn folgende Punkte funktionieren:

- [ ] Bridge verbindet sich mit vMix
- [ ] Makros koennen geladen werden
- [ ] Makros koennen ausgeloest werden
- [ ] Eine Broadify-HTML5-Seite ist als vMix Browser Input ladbar
- [ ] Diese Seite rendert transparent und stabil
- [ ] Graphics-Datenupdates erscheinen im Browser Input
- [ ] vMix kann diesen Browser Input im Programm mischen und ausspielen

## Spaeterer Ausbau nach v1

Moegliche Folgephasen:

- `v1.x`
  - Preview/Program/Input-State sauber lesen
  - Overlay-/Input-Steuerung
  - Browser-Input-Komfortfunktionen

- `v2`
  - Broadify gerenderter Stream nach vMix via NDI/OMT
  - echter Video-/Alpha-Ingest statt Browser-Input

## Risiken

### Technische Risiken

- Browser-Input-Rendering kann empfindlicher sein als nativer Video-Output
- Font-/Asset-/Cache-Verhalten kann zwischen Maschinen variieren
- Lokale URLs funktionieren nur im same-machine-Setup sauber
- Remote-vMix erfordert erreichbare Grafik-URL

### Produkt-Risiken

- Browser-Input kann von Nutzern spaeter mit "echtem Streaming" verwechselt werden
- Ohne klare UX kann der Operator nicht erkennen, ob ein Browser Input in vMix korrekt eingerichtet ist

## Abschlusskriterien

Die Integration gilt fuer `v1` als erfolgreich, wenn:

- [ ] der Laptop-Flow technisch sauber funktioniert
- [ ] Controls ueber Bridge -> vMix robust arbeiten
- [ ] Graphics als HTML5 Browser Input in vMix stabil laufen
- [ ] vMix die Broadify-Grafiken als normalen Input mischen und ausspielen kann
- [ ] der Operator den Setup-Prozess reproduzierbar versteht

## Relevante interne Referenzen

- Bridge Relay-Protokoll: `docs/bridge/features/relay-protocol.md`
- Bridge Relay-Architektur: `docs/bridge/architecture/relay-enterprise-architecture.md`
- Bridge vMix Adapter: `apps/bridge/src/services/engine/adapters/vmix-adapter.ts`
- Bridge Command Router: `apps/bridge/src/services/command-router.ts`
- Bridge Server: `apps/bridge/src/server.ts`
- WebApp Bridge Command API: `broadify/app/api/bridges/[bridgeId]/command/route.ts`
- WebApp Engine UI: `broadify/app/(pages)/(with-nav)/dashboard/components/engine-section.tsx`
- WebApp Engine Store: `broadify/lib/stores/engine-store.ts`
- WebApp Graphics Bridge Slice: `broadify/stores/graphics-store.bridge.ts`
- WebApp Relay Graphics Updates: `broadify/hooks/use-relay-graphics-updates.ts`
- WebApp Template Runtime: `broadify/lib/template-builder/domain/render.ts`
- Relay Server: `broadify-relay/src/index.ts`

## Oeffentliche vMix-Quellen

- Developer Information: `https://www.vmix.com/help26/DeveloperInformation.html`
- Developer API: `https://www.vmix.com/help29/DeveloperAPI.html`
- Browser Input / Web Browser: `https://www.vmix.com/help26/WebBrowser.html`
- User Guide / Browser-Input-Kontext: `https://www.vmix.com/help29/vMixUserGuide.pdf`
