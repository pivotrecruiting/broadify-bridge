# vMix Browser Input Remote – Umsetzungsplan

## Ziel

Dieser Plan beschreibt die vollstaendige Erweiterung des bestehenden `vmix` + `browser_input`-Pfads fuer einen **Remote-vMix-Betrieb im LAN**.

Zielbild:

- Broadify Bridge laeuft auf Rechner A
- vMix laeuft auf Rechner B
- Broadify WebApp oder Desktop-App kann auf Rechner A, B oder einem dritten Operator-Rechner laufen
- vMix laedt die Broadify-Browser-Input-Seite **nicht** mehr ueber `127.0.0.1`, sondern ueber eine vom vMix-Rechner aus erreichbare Bridge-Adresse
- HTTP, Assets, Snapshot und WebSocket funktionieren dabei konsistent ueber denselben Remote-Pfad

Kurz:

- Controls/Makros/Funktionen -> Bridge steuert vMix weiter per API
- Graphics -> vMix laedt die Broadify-HTML5-Seite remote von der Bridge ueber LAN

## Warum das ein eigener Plan ist

Der bestehende `v1`-Pfad ist bewusst als `same-machine first` gebaut:

- Browser-Input-URLs werden absichtlich als `127.0.0.1` ausgegeben
- der Browser-Input-Pfad ist supportbar, weil Bridge und vMix auf derselben Maschine laufen
- der Remote-Fall fuehrt neue Anforderungen ein:
  - adressierbare Bridge-URL statt Loopback
  - bewusstes Expositionsmodell
  - hoehere Netzwerkanfaelligkeit
  - anderer Sicherheitsrahmen fuer Snapshot, Assets und WebSocket

Remote-vMix ist deshalb **kein kleiner Toggle**, sondern ein eigenes Betriebsmodell.

## Zielbild

### Topologie A – Empfohlen fuer Remote

1. Bridge laeuft auf einem stabilen LAN-Host mit fester IP oder DNS-Namen.
2. vMix laeuft auf einem anderen Rechner im selben Netz.
3. Die Bridge wird bewusst fuer Remote-Browser-Input exponiert.
4. Die Graphics-Konfiguration erzeugt fuer `browser_input` eine **remote-faehige URL-Basis**.
5. vMix laedt:
   - HTML-Seite
   - Snapshot
   - Assets
   - WebSocket
   jeweils ueber diese Remote-Basis.

Beispiel:

- Bridge API lokal: `http://127.0.0.1:8787`
- Bridge Remote-Browser-Input-Basis: `http://192.168.1.20:8787`
- Browser-Input-URL: `http://192.168.1.20:8787/graphics/browser-input`
- Browser-Input-WS-URL: `ws://192.168.1.20:8787/graphics/browser-input/ws`
- vMix API: `http://192.168.1.30:8088`

### Topologie B – Reverse Proxy / DNS

Optional spaeter:

- Bridge bleibt lokal nur auf Loopback gebunden
- ein vorgelagerter Reverse Proxy exponiert nur den Browser-Input-Pfad
- Broadify arbeitet intern weiter mit lokaler API, aber Browser-Input mit oeffentlicher oder LAN-DNS-URL

Das ist langfristig sauber, aber fuer den ersten Remote-LAN-Scope nicht noetig.

## Nicht-Ziele

Nicht Teil dieses Plans:

- Internet-öffentliche Exposition ohne zusaetzliche Absicherung
- NAT-/WAN-Zugriff
- Multi-Bridge-Loadbalancing
- TLS-/Zertifikatsautomatisierung als Pflicht fuer den ersten LAN-Scope
- NDI-/Video-Ingest als Alternative zum Browser Input

## Produktanforderungen

Die Remote-Funktion ist erreicht, wenn:

- Broadify kann neben `same_machine` auch einen **bewusst aktivierten Remote-Modus** fuer `browser_input` konfigurieren
- die generierte Browser-Input-URL ist vom vMix-Rechner aus erreichbar
- Snapshot, Assets und WebSocket funktionieren ueber dieselbe Basisadresse
- der optionale API-Komfortpfad `engine_vmix_ensure_browser_input` verwendet die **remote-faehige** URL
- der bestehende Localhost-Default bleibt fuer `v1` erhalten und wird nicht stillschweigend ersetzt

## Bestehender Ist-Stand

Bereits vorhanden:

- `browser_input` als Graphics-Output-Modus
- Bridge-hosted Browser-Input-Seite
- Snapshot-Endpoint
- Asset-Endpoint
- WebSocket fuer Live-Updates
- Browser-Input-Metadaten in `graphics_status`
- optionaler vMix-Komfortbefehl zum Anlegen/Navigieren des Browser Inputs
- Security-Guard `local-or-token`
- same-machine-first URL-Policy mit Loopback-Ausgabe

Noch nicht vorhanden:

- explizites Remote-Browser-Input-Betriebsmodell
- konfigurierbare externe Browser-Input-Basisadresse
- verifizierbare Trennung zwischen lokaler API-Adresse und externer Browser-Input-Adresse
- UX fuer Remote-URL, Remote-Warnungen und Netztest
- QA-Runbook fuer echten Remote-LAN-Betrieb

## Architekturentscheidung

Fuer Remote-vMix sollte **nicht** einfach die bestehende Server-Bindung als URL nach aussen gespiegelt werden.

Stattdessen:

1. Die Bridge behaelt ihre interne Laufzeitadresse wie bisher.
2. Fuer `browser_input` wird eine **explizite, konfigurierte Expositionsbasis** eingefuehrt.
3. Nur wenn diese Basis aktiv gesetzt und freigegeben ist, darf `browser_input` remote-faehige URLs ausgeben.
4. Ohne diese Konfiguration bleibt alles bei Loopback.

Begruendung:

- vermeidet versehentliche LAN-Exposition
- trennt lokale API-Nutzung und Browser-Input-Exposition sauber
- ermoeglicht spaeter Reverse-Proxy- oder DNS-Setups
- reduziert Support-Faelle, in denen eine zufaellige Bind-Adresse als Produkt-URL missverstanden wird

## Empfohlenes Konfigurationsmodell

### Neue Runtime-Konfiguration

Empfohlene neue Felder:

```ts
type BrowserInputExposureModeT =
  | "local_only"
  | "remote_lan";

type BrowserInputExposureConfigT = {
  mode: BrowserInputExposureModeT;
  publicBaseUrl?: string;
  requireTokenForRemote?: boolean;
};
```

Semantik:

- `local_only`
  - aktuelles Verhalten
  - URLs bleiben `127.0.0.1`
- `remote_lan`
  - Browser-Input-URLs werden aus `publicBaseUrl` abgeleitet
  - `publicBaseUrl` ist Pflicht
  - die Bridge validiert, dass Protokoll, Host und optionaler Port syntaktisch gueltig sind

### Wichtige Regel

`publicBaseUrl` ist **nicht** automatisch:

- die Fastify-Bind-Adresse
- die erkannte LAN-IP
- die Relay-URL

`publicBaseUrl` ist ein bewusst gesetzter Produktwert.

## URL-Modell

### Local-only

- Page: `http://127.0.0.1:<port>/graphics/browser-input`
- State: `http://127.0.0.1:<port>/graphics/browser-input/state`
- WS: `ws://127.0.0.1:<port>/graphics/browser-input/ws`

### Remote-LAN

Aus `publicBaseUrl = http://bridge-host:8787` folgt:

- Page: `http://bridge-host:8787/graphics/browser-input`
- State: `http://bridge-host:8787/graphics/browser-input/state`
- WS: `ws://bridge-host:8787/graphics/browser-input/ws`

### Regeln

- keine gemischten Hosts zwischen Page, Assets, Snapshot und WS
- keine automatische Fallback-Mischung auf `127.0.0.1`
- bei `https` muss `wss` fuer den WebSocket erzeugt werden
- Trailing Slash in `publicBaseUrl` wird normalisiert

## Security-Modell

Remote-vMix erfordert ein strikteres Modell als same-machine.

### Entscheidung fuer Phase 1 des Remote-Plans

Empfohlen:

- Page-Request darf ohne separaten User-Login funktionieren
- Remote-Zugriff wird ueber **Bridge-API-Token** oder einen dedizierten Browser-Input-Token abgesichert
- WebSocket, Snapshot und Assets muessen mit demselben Modell funktionieren

### Best Practice

Mittelfristig sauberer als Wiederverwendung des globalen API-Tokens:

```ts
type BrowserInputAccessTokenT = {
  token: string;
  scope: "browser_input";
  bridgeId: string;
  expiresAt?: string | null;
};
```

Begruendung:

- geringer Blast Radius
- klarere Logs
- gezielte Rotation moeglich
- kein Teilen eines globalen Admin-Tokens in vMix-URLs

### Mindestanforderung

Falls kurzfristig kein dedizierter Token gebaut wird, muss mindestens gelten:

- Remote nur bei expliziter Aktivierung
- Token niemals in Logs ausschreiben
- UI warnt deutlich, wenn ein Token in der Browser-Input-URL verwendet wird
- unautorisierte WebSocket-Clients werden weiterhin sofort abgewiesen

## Technische Gaps

### 1. Browser-Input-Runtime

Erweiterungen noetig:

- URL-Erzeugung muss `local_only` und `remote_lan` unterscheiden
- `browserInputUrl` und `browserInputWsUrl` muessen aus `publicBaseUrl` ableitbar sein
- `graphics_status` braucht Exposure-Metadaten

Empfohlene neue Metadaten:

- `exposureMode`
- `publicBaseUrl`
- `remoteReachabilityStatus`
- `accessMode`

### 2. Route Guards

Pruefen und anpassen:

- aktueller `local-or-token`-Guard ist lokal optimiert
- fuer Remote muss klar sein, welche Browser-Input-Routen ohne lokalen Socket-Zugriff erreichbar sein duerfen
- HTML, Snapshot, Assets und WS muessen konsistent behandelt werden

### 3. vMix-Komfortpfad

`engine_vmix_ensure_browser_input` muss:

- bei `remote_lan` die externe Browser-Input-URL verwenden
- keine Loopback-URL nach vMix schreiben
- bei fehlender Remote-Konfiguration einen klaren Fehler liefern

### 4. WebApp und Desktop-UX

Noetig:

- Umschalter `Same machine` vs. `Remote vMix`
- Eingabefeld fuer `publicBaseUrl`
- Statushinweise fuer:
  - Token erforderlich
  - Firewall prüfen
  - DNS/IP pruëfen
  - vMix muss diese Adresse erreichen koennen
- explizite Warnung, dass `127.0.0.1` auf dem vMix-Rechner endet, nicht auf dem Bridge-Rechner

### 5. Reachability / Diagnose

Hilfreich fuer Support:

- Bridge kann eine lokale syntaktische URL-Pruefung machen
- optionaler Diagnose-Endpunkt fuer Browser-Input-Config
- UI-Checkliste statt automatischer "echter" Remote-Erreichbarkeitsbehauptung

Wichtig:

- Die Bridge kann nicht belastbar aus sich selbst heraus beweisen, dass der vMix-Rechner die URL wirklich erreicht.
- Deshalb keine falschen Health-Aussagen im Produkt.

## Umsetzungsphasen

## Phase 0 – Zielmodell festziehen

Ziel:
Remote-Browser-Input als explizites Produktmodell definieren.

Todos:

- [ ] `local_only` und `remote_lan` als Exposure-Modi festlegen
- [ ] Entscheidung fuer Token-Modell treffen:
  - [ ] globaler Bridge-Token als Zwischenloesung oder
  - [ ] dedizierter Browser-Input-Token als Zielmodell
- [ ] Konfigurationseigentuemer festlegen:
  - [ ] Bridge Runtime
  - [ ] WebApp Settings
  - [ ] Desktop Settings
- [ ] explizit festhalten, dass `same-machine` Default bleibt

Abnahme:

- [ ] alle beteiligten Komponenten verwenden dieselbe Begrifflichkeit und denselben Exposure-Contract

## Phase 1 – Bridge-Konfig und URL-Bildung

Ziel:
Die Bridge kann remote-faehige Browser-Input-URLs kontrolliert erzeugen.

Todos:

- [ ] neue Exposure-Konfiguration in Bridge-Runtime aufnehmen
- [ ] Parser/Validator fuer `publicBaseUrl` bauen
- [ ] Normalisierung fuer `http/https`, Host, Port und Trailing Slash
- [ ] URL-Erzeugung fuer:
  - [ ] Page
  - [ ] Snapshot
  - [ ] Assets
  - [ ] WebSocket
- [ ] `graphics_status` und `graphics_list` um Exposure-Metadaten erweitern
- [ ] bestehendes Loopback-Verhalten als Default beibehalten

Abnahme:

- [ ] ohne Remote-Konfiguration bleibt alles bei Loopback
- [ ] mit `remote_lan` werden konsistente Remote-URLs generiert

## Phase 2 – Security und Access-Modell

Ziel:
Remote-Zugriff ist bewusst freigegeben und nicht versehentlich offen.

Todos:

- [ ] Guard-Verhalten fuer Remote-Browser-Input-Routen definieren
- [ ] entscheiden, ob:
  - [ ] Query-Token
  - [ ] Header-Token
  - [ ] signierte Einmal-URL
  verwendet wird
- [ ] Browser-Input-spezifisches Tokenmodell implementieren oder globalen Token bewusst kapseln
- [ ] Logging auf Token-Redaktion pruefen
- [ ] Fehlercodes fuer `unauthorized`, `forbidden`, `token_missing`, `token_expired` schaerfen

Abnahme:

- [ ] unautorisierter Remote-Zugriff scheitert deterministisch
- [ ] autorisierter Remote-Zugriff funktioniert fuer HTML, Assets, Snapshot und WS konsistent

## Phase 3 – vMix-Komfortpfad und API-Integration

Ziel:
Der Komfortbefehl schreibt im Remote-Modus die richtige URL nach vMix.

Todos:

- [ ] `engine_vmix_ensure_browser_input` auf Exposure-Metadaten umstellen
- [ ] bei `remote_lan` die externe URL verwenden
- [ ] klare Fehlermeldung, wenn Remote-Modus aktiv ist, aber keine gueltige `publicBaseUrl` existiert
- [ ] Tests fuer:
  - [ ] local_only
  - [ ] remote_lan
  - [ ] fehlende Remote-Konfiguration

Abnahme:

- [ ] vMix bekommt nie versehentlich eine falsche Loopback-URL im Remote-Modus

## Phase 4 – WebApp- und Desktop-UX

Ziel:
Operatoren koennen den Remote-Fall ohne Trial-and-Error konfigurieren.

Todos:

- [ ] UI fuer Exposure-Modus
- [ ] Feld fuer `publicBaseUrl`
- [ ] Hinweise fuer:
  - [ ] Beispielwert
  - [ ] Token-Anforderung
  - [ ] Firewall
  - [ ] DNS/IP
- [ ] Copy-Buttons fuer:
  - [ ] Page-URL
  - [ ] gegebenenfalls tokenisierte URL
- [ ] CTA-Texte fuer manuellen und API-Komfortpfad anpassen
- [ ] Desktop-App auf denselben Contract ziehen

Abnahme:

- [ ] UI macht den Unterschied zwischen lokal und remote explizit sichtbar

## Phase 5 – Teststrategie

Ziel:
Der Remote-Slice ist regressionssicher.

Todos:

- [ ] Unit-Tests fuer URL-Normalisierung
- [ ] Tests fuer `https -> wss`
- [ ] Tests fuer Token-/Guard-Verhalten
- [ ] Tests fuer `graphics_status`-Exposure-Metadaten
- [ ] Tests fuer Komfortpfad mit Remote-URL
- [ ] Regressionstests, dass bestehende same-machine-Flows unveraendert bleiben

Abnahme:

- [ ] Remote-Logik ist testseitig abgedeckt, ohne den bestehenden Localhost-Pfad zu brechen

## Phase 6 – QA-Runbook fuer echtes LAN-Setup

Ziel:
Der Flow ist auf realen zwei Maschinen reproduzierbar.

Todos:

- [ ] separates QA-Runbook fuer:
  - [ ] Bridge-Rechner
  - [ ] vMix-Rechner
  - [ ] optionalen Operator-Rechner
- [ ] Checkliste fuer:
  - [ ] Firewall
  - [ ] Namensaufloesung
  - [ ] Port-Erreichbarkeit
  - [ ] Token-Weitergabe
  - [ ] Browser-Input-Reload
- [ ] Negativtests:
  - [ ] falsche URL
  - [ ] Token fehlt
  - [ ] WS blockiert
  - [ ] Asset-Request blockiert

Abnahme:

- [ ] der komplette Remote-Flow ist dokumentiert und manuell wiederholbar

## Risiken

### Technische Risiken

- Remote-URL ist im Browser, aber WebSocket oder Assets scheitern separat
- DNS-/Hostname-Probleme fuehren zu intermittierenden Fehlern
- Firewalls erlauben HTML, aber blockieren WebSocket
- Token in Query-Strings koennen ungewollt in Screenshots oder Support-Notizen auftauchen
- `https`/`wss` wird spaeter relevant, wenn gemischte Inhalte oder Proxying eingefuehrt werden

### Produkt-Risiken

- Operatoren verwechseln Bridge-IP und vMix-IP
- Support-Aufwand steigt stark, wenn der Remote-Modus nicht explizit als fortgeschrittener Modus markiert ist
- Ein "automatisch erkannte LAN-IP" wirkt bequem, fuehrt aber haeufig zu falschen oder instabilen URLs

## Explizite Nicht-Empfehlungen

Folgende Kurzschluesse sollten vermieden werden:

- "Wenn Fastify an `0.0.0.0` bindet, nehmen wir einfach diese Adresse"
- "Wir ersetzen `127.0.0.1` generell durch die erste LAN-IP"
- "Nur die HTML-Seite bekommt eine Remote-URL, Assets und WS bleiben lokal"
- "Remote-Zugriff ohne bewusstes Security-Modell ist fuer internes LAN schon okay"

Diese Varianten sind kurzfristig bequem, aber support- und sicherheitstechnisch schwach.

## Implementation-ready Entscheidungsempfehlung

Fuer einen sauberen ersten Remote-Scope wird empfohlen:

1. `same-machine` bleibt Default.
2. Es gibt einen expliziten Exposure-Modus `remote_lan`.
3. `remote_lan` verlangt eine manuell gesetzte `publicBaseUrl`.
4. Browser-Input-Routen werden remote nur mit Token freigegeben.
5. Die WebApp und Desktop-App zeigen klare Remote-Warnungen und Operator-Hinweise.
6. Erst danach folgt reale Zwei-Maschinen-QA.

## Offene Fragen

Diese Punkte sind vor Implementierungsstart noch final zu entscheiden:

- Wird fuer Remote-LAN ein dedizierter Browser-Input-Token gebaut oder zunaechst der bestehende Bridge-Token wiederverwendet?
- Soll `publicBaseUrl` nur `http` erlauben oder `https` direkt mitunterstuetzen?
- Soll der Remote-Modus bereits in der Desktop-App konfigurierbar sein oder zunaechst nur in der WebApp?
- Soll der Komfortpfad tokenisierte URLs direkt nach vMix schreiben duerfen, oder bleibt das nur ein manueller Copy-Pfad?

## Empfohlene Reihenfolge

1. Phase 0
2. Phase 1
3. Phase 2
4. Phase 3
5. Phase 4
6. Phase 5
7. Phase 6
