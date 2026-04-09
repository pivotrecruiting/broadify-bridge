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

- WebApp: `http://127.0.0.1:<webapp-port>`
- Bridge: lokal
- vMix API: `http://127.0.0.1:8088`
- vMix Browser Input: `http://127.0.0.1:<webapp-port>/...`

## Variante B – Moeglich, aber komplexer

vMix laeuft auf einem anderen Rechner im LAN.

Dann gilt:

- Bridge kann Controls/Makros/Funktionen weiter per LAN-API an vMix senden
- aber die Grafik-URL muss **vom vMix-Rechner aus erreichbar** sein

Das bedeutet:

- `localhost` auf dem Laptop reicht dann fuer den Browser Input nicht
- die Grafikseite muss ueber LAN oder oeffentliche URL erreichbar sein

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

### Noch nicht ausreichend vorhanden

- Die Bridge modelliert vMix aktuell nur sehr schmal
- Die Desktop-App ist lokal noch ATEM-fixiert
- Es gibt noch keinen dedizierten Browser-Input-Grafikpfad fuer vMix
- Es gibt noch kein Broadify-vMix-HTML5-Handshakemodell
- Es gibt noch keine produktive Verwaltung von vMix Browser Input URLs / Sessions / Input-Referenzen

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

- eine Broadify-HTML5-Grafikseite fuer vMix bereitstellen
- diese Seite mit Daten versorgen
- eine feste URL fuer einen vMix Browser Input erzeugen oder bereitstellen
- die Grafikupdates an diese Seite senden
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
- Welche URL-Topologie wird fuer `v1` festgelegt:
  - lokale URL
  - LAN-URL
  - Relay-/Cloud-URL
- Wie wird die Grafikseite authentisiert oder abgesichert, ohne den Browser-Input unnoetig zu komplizieren?
- Soll `v1` nur einen festen Browser Input pro Bridge/vMix verwenden oder mehrere?
- Soll die Bridge den Browser-Input nur dokumentiert referenzieren oder aktiv per API helfen, ihn zu konfigurieren?

## Architekturregeln fuer v1

### 1. vMix bleibt Mischer, nicht Grafikquelle

- Keine Nutzung des nativen vMix-Titel-/GT-Systems als primaerer Broadify-Grafikpfad
- Keine Broadify-Templates in vMix-Title-Projekten nachbauen

### 2. Browser Input ist ein expliziter Integrationsmodus

- HTML5-Rendering ueber Browser Input ist der definierte `v1`-Modus
- Der Browser Input ist kein Workaround, sondern bewusstes Produktverhalten fuer `v1`

### 3. Controls und Graphics sind getrennte Integrationspfade

- Controls laufen ueber vMix API
- Graphics laufen ueber Browser Input URL
- Beide Pfade sollen in UI und Code getrennt modelliert werden

### 4. Lokaler Single-Machine-Pfad zuerst

- `v1` soll zuerst fuer `WebApp + Bridge + vMix auf einem Laptop` sauber funktionieren
- LAN-Remote-vMix ist nachrangig

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

### Todos

- [ ] `v1` offiziell als `HTML5 Browser Input`-Modus festlegen.
- [ ] Das alte Zielbild `Broadify rendert Stream nach vMix` explizit aus dem `v1`-Scope ausschliessen.
- [ ] Standard-Betriebsmodus definieren:
  - [ ] same machine first
  - [ ] LAN second
- [ ] Reale vMix-Browser-Input-Spikes durchfuehren:
  - [ ] lokale URL laden
  - [ ] Transparenz pruefen
  - [ ] Font-Laden pruefen
  - [ ] CSS-/Animation-Verhalten pruefen
  - [ ] Resize-/Aspect-Verhalten pruefen
  - [ ] Datenupdates pruefen
- [ ] Entscheiden, ob Browser-Input-Seiten oeffentlich, lokal oder tokenisiert ausgeliefert werden.
- [ ] Dokumentieren, wie viele Browser Inputs `v1` unterstuetzt:
  - [ ] genau 1
  - [ ] 1 pro Grafikslot
  - [ ] frei konfigurierbar

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

- [ ] Einen dedizierten `vMix Browser Input Graphics Mode` definieren.
- [ ] URL-Konzept festlegen.
- [ ] Standard-Routen fuer Browser-Input-Grafiken definieren.
- [ ] Eine stabile HTML-Seite fuer vMix Browser Input bereitstellen.
- [ ] Die Seite muss Broadify-Graphics rendern koennen.
- [ ] Transparenter Hintergrund muss sauber unterstuetzt werden.
- [ ] Asset-Ladeverhalten fuer Fonts/Bilder/CSS stabilisieren.
- [ ] Caching-Verhalten definieren.
- [ ] Reload-/Recover-Verhalten definieren.

### Offene Designentscheidung innerhalb dieser Phase

- [ ] Eine feste URL pro Bridge
- [ ] Eine URL pro Grafikslot
- [ ] Eine URL mit Zustand/Session-Parametern

### Abnahme

- [ ] vMix kann die Broadify-Grafikseite als Browser Input laden und sichtbar rendern.

## Phase 3 – Daten- und Zustandsmodell fuer Browser-Input-Grafiken

Ziel:
Die Graphics Section muss der Browser-Input-Seite Daten und Zustand liefern koennen.

### Todos

- [ ] Definieren, wie die Browser-Input-Seite ihren Zustand erhaelt:
  - [ ] Query params
  - [ ] initial payload
  - [ ] polling endpoint
  - [ ] websocket/realtime
- [ ] Ein dediziertes Datenmodell fuer Browser-Input-Grafiken definieren.
- [ ] Graphics Section an diesen Modus anbinden.
- [ ] Update-Flows fuer:
  - [ ] initial render
  - [ ] text/value updates
  - [ ] layout updates
  - [ ] remove/reset
- [ ] Fehlerfall modellieren:
  - [ ] Seite nicht erreichbar
  - [ ] Assets fehlen
  - [ ] Grafikdaten ungueltig
- [ ] Sichtbar machen, ob die Browser-Input-Seite einen gueltigen Zustand hat.

### Abnahme

- [ ] Broadify kann Grafikdaten an eine Browser-Input-Seite uebergeben und diese aktualisieren.

## Phase 4 – WebApp UX fuer vMix Browser Input

Ziel:
Die WebApp soll klar und produktiv mit dem Browser-Input-Modell umgehen koennen.

### Todos

- [ ] Engine-UI fuer `vmix` finalisieren.
- [ ] In der Graphics Section einen `vMix Browser Input`-Modus sichtbar machen.
- [ ] Dem Nutzer die benoetigte Browser-Input-URL anzeigen.
- [ ] Optional Copy/Launch-Helfer fuer die URL anbieten.
- [ ] Klare Statusanzeigen einfuehren:
  - [ ] vMix verbunden
  - [ ] Grafikseite bereit
  - [ ] Browser-Input-URL vorhanden
  - [ ] Browser-Input vermutlich aktiv / nicht aktiv
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

- [ ] Bestehenden Graphics-Commandpfad weiterverwenden, wo moeglich.
- [ ] Browser-Input-spezifische Graphics-Commands oder Modusfelder definieren.
- [ ] Sicherstellen, dass Relay/Bridge fuer diesen Modus keine unnötigen Video-Output-Annahmen treffen.
- [ ] Falls noetig Status-Snapshots fuer Browser-Input-Grafiken ueber Relay publizieren.
- [ ] Falls sinnvoll `graphics_status` fuer Browser-Input-Modus erweitern.
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

### Abnahme

- [ ] Der lokale Laptop-Flow funktioniert sowohl aus der WebApp als auch aus der Desktop-App nachvollziehbar.

## Phase 8 – Security und Betriebsmodell

Ziel:
Der Browser-Input-Ansatz muss supportbar und sicher genug fuer den Zielbetrieb sein.

### Todos

- [ ] URL-Sicherheitsmodell definieren.
- [ ] Entscheiden, ob `v1`:
  - [ ] nur lokal
  - [ ] lokal + LAN
  - [ ] optional cloud-erreichbar
  unterstuetzt.
- [ ] Falls Browser-Input-URL nicht oeffentlich sein soll:
  - [ ] lokalen Zugriff sauber spezifizieren
  - [ ] Remote-vMix fuer `v1` einschränken oder ausschliessen
- [ ] Logging-Regeln definieren:
  - [ ] keine sensiblen Payloads
  - [ ] keine Secrets in Browser-Input-URLs
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
- WebApp Bridge Command API: `broadify/app/api/bridges/[bridgeId]/command/route.ts`
- WebApp Pairing API: `broadify/app/api/bridges/pair/route.ts`
- WebApp Engine UI: `broadify/app/(pages)/(with-nav)/dashboard/components/engine-section.tsx`
- Relay Server: `broadify-relay/src/index.ts`

## Oeffentliche vMix-Quellen

- Developer Information: `https://www.vmix.com/help26/DeveloperInformation.html`
- Developer API: `https://www.vmix.com/help29/DeveloperAPI.html`
- Browser Input / Web Browser: `https://www.vmix.com/help26/WebBrowser.html`
- User Guide / Browser-Input-Kontext: `https://www.vmix.com/help29/vMixUserGuide.pdf`
