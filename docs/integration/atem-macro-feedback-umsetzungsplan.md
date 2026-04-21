# ATEM Macro Feedback – Umsetzungsplan

## Ziel

Dieser Plan beschreibt die vollstaendige Integration eines belastbaren Macro-Feedback-Modells fuer ATEM in der Broadify-Bridge und der Broadify-Webapp.

Zielbild:

- Ein gestartetes ATEM-Macro liefert nicht nur ein synchrones "Command accepted", sondern einen echten Laufzeitstatus.
- Broadify erkennt, wann ein Macro:
  - gestartet wurde,
  - aktiv laeuft,
  - auf einen Wait-Zustand blockiert,
  - beendet wurde,
  - gestoppt wurde.
- Die Broadify-Webapp zeigt denselben operativen Nutzen wie heute bei Graphics:
  - aktueller Status,
  - tatsaechliche Laufzeit,
  - saubere Completion-Rueckmeldung,
  - belastbare UI/Toast/Control-Logik.

## Hintergrund

Graphics und ATEM-Macros unterscheiden sich fachlich:

- Graphics in Broadify haben ein eigenes Preset-/Timer-Modell mit `durationMs`, `startedAt` und `expiresAt`.
- ATEM-Macros haben keine gleichwertige, immer verlaessliche geplante Endzeit.
- ATEM liefert stattdessen Runtime-Feedback aus dem Geraetezustand.

Daraus folgt:

- Bei Graphics ist die geplante Dauer Teil des Payloads.
- Bei ATEM-Macros ist die tatsaechliche Ausfuehrung die Quelle der Wahrheit.

Der Plan verwendet daher bewusst kein Graphics-Klonmodell, sondern ein execution-basiertes Runtime-Modell.

## Nicht-Ziele

Nicht Teil von v1:

- Vorab-Berechnung einer garantiert korrekten Macro-Gesamtdauer.
- Unterstützung paralleler ATEM-Macro-Ausfuehrungen.
- Tiefenanalyse des Macro-Inhalts durch Parsing exportierter Macro-Dateien.
- Neue Remote-/Expose-Flaechen ausserhalb der bereits bestehenden Relay- und Bridge-Pfade.

Optional spaeter:

- `engine_continue_macro` fuer ATEM User-Wait-Macros.
- Historie mehrerer beendeter Executions.
- Analytics/Reporting fuer durchschnittliche Macro-Laufzeiten.

## Ist-Stand

### Bridge

Relevanter aktueller Code:

- `apps/bridge/src/services/engine/adapters/atem-adapter.ts`
- `apps/bridge/src/services/engine-adapter.ts`
- `apps/bridge/src/routes/engine.ts`
- `apps/bridge/src/routes/websocket-contract.ts`
- `packages/protocol/src/index.ts`
- `apps/bridge/src/services/graphics/graphics-preset-timer.ts`
- `apps/bridge/src/services/graphics/graphics-event-publisher.ts`

Aktuelle Beobachtungen:

- Der ATEM-Adapter hoert bereits auf `stateChanged` und aktualisiert daraus Macro-Zustaende.
- Die installierte `atem-connection`-Version liefert bereits `macroPlayer.isRunning`, `macroPlayer.isWaiting`, `macroPlayer.loop` und `macroPlayer.macroIndex`.
- Der aktuelle Adapter wertet `isWaiting` und `loop` noch nicht fachlich aus.
- Der aktuelle Adapter markiert ein Macro zu aggressiv als `running`, wenn nur `macroIndex` passt.
- `engine-adapter.ts` broadcastet bereits:
  - `engine.status`
  - `engine.connected`
  - `engine.disconnected`
  - `engine.error`
  - `engine.macros`
  - `engine.macroStatus`
- Es existiert noch kein eigener Execution-State fuer Macros.
- Es existiert noch kein Bridge-Event-Publisher analog zu Graphics fuer Engine-Macro-Runtime.

### Broadify-Webapp

Der Webapp-Teil wurde ueber den `workspace`-MCP identifiziert und anschliessend im lokalen Checkout gelesen.

Relevanter aktueller Code:

- `broadify/app/api/bridges/[bridgeId]/command/route.ts`
- `broadify/lib/bridge-commands.ts`
- `broadify/lib/stores/engine-store.ts`
- `broadify/types/engine-types.ts`
- `broadify/hooks/use-relay-graphics-updates.ts`
- `broadify/stores/controls-macros-store.ts`
- `broadify/hooks/use-controls-data.ts`
- `broadify/app/(pages)/(with-nav)/dashboard/controls/page.tsx`
- `broadify/lib/bridge-notifications.ts`
- `broadify/stores/graphics-store.bridge.ts`

Aktuelle Beobachtungen:

- Die Next.js-API `app/api/bridges/[bridgeId]/command/route.ts` leitet Bridge-Commands generisch an den Relay weiter.
- `lib/bridge-commands.ts` kennt bereits:
  - `engine_get_status`
  - `engine_get_macros`
  - `engine_run_macro`
  - `engine_stop_macro`
- Die Webapp kennt fuer Graphics bereits einen produktiven Relay-WebSocket-Updatepfad in `hooks/use-relay-graphics-updates.ts`.
- Fuer Engine/Macro-Runtime gibt es in der Webapp derzeit keinen gleichwertigen Relay-Live-Update-Hook.
- `lib/stores/engine-store.ts` arbeitet heute polling-basiert ueber `engine_get_status`.
- `stores/controls-macros-store.ts` laedt Macros ueber `engine_get_macros`, behandelt sie aber primär als statische Auswahl-/Persistenzdaten.
- `dashboard/controls/page.tsx` triggert Makros direkt ueber `bridgeCommands.engineRunMacro(...)`.
- Die Controls-UI zeigt aktuell nur Dispatch-/Error-Zustaende, aber keinen echten Macro-Lifecycle.
- `lib/bridge-notifications.ts` formuliert Erfolg heute als "gestartet", nicht als "wirklich beendet".
- In `types/engine-types.ts` existieren bereits Basistypen fuer `engine.macros` und `engine.macroStatus`, aber kein Execution-Modell.

## Architekturentscheidung

### 1. Macro-Katalog und Macro-Execution werden getrennt modelliert

`MacroT` bleibt die definitorische Liste verfuegbarer Macros.

Neu kommt ein Runtime-Modell fuer die aktuell laufende oder zuletzt beendete Ausfuehrung hinzu.

Das ist noetig, weil:

- dieselbe Macro-Definition mehrfach im Leben einer Session gestartet werden kann,
- die Definition stabil ist,
- die Ausfuehrung aber ein zeitgebundener Lauf mit eigenem Status ist.

### 2. Execution ist die Quelle der Wahrheit fuer "laeuft noch / wartet / fertig"

Die Bridge leitet den ATEM-Geraetezustand in ein eigenes Execution-Modell ueber.

Das Modell wird nicht aus UI-Annahmen oder Request/Response-Heuristiken erzeugt, sondern aus:

- `runMacro(...)`
- `stopMacro(...)`
- `stateChanged`
- `macroPlayer.isRunning`
- `macroPlayer.isWaiting`
- `macroPlayer.loop`
- `macroPlayer.macroIndex`

### 3. Snapshots und Events werden kombiniert

Wie bei Graphics soll es zwei Ebenen geben:

- Snapshot fuer Initialzustand und Resync.
- Events fuer Live-Uebergaenge.

Empfohlener Datenweg:

- Snapshot ueber `engine_get_status`.
- Live-Events ueber Bridge-Events via Relay.

### 4. Rueckwaertskompatibilitaet bleibt erhalten

Bestehende Kommandos bleiben bestehen:

- `engine_get_macros`
- `engine_run_macro`
- `engine_stop_macro`

Bestehende einfache Macro-Statusfelder bleiben ebenfalls erhalten, werden aber intern aus dem neuen Runtime-Modell abgeleitet.

## Ziel-Datenmodell

### Erweiterung der Macro-Statuswerte

Empfohlene Erweiterung fuer den Makro-Katalog:

```ts
type MacroStatusT =
  | "idle"
  | "pending"
  | "running"
  | "waiting"
  | "recording";
```

Hinweise:

- `completed` und `stopped` sollten keine dauerhaften Katalog-Status sein.
- Nach Abschluss springt ein Macro im Katalog wieder auf `idle`.
- `completed` und `stopped` gehoeren in das Execution-Modell.

### Neues Execution-Modell

Empfohlener Shared-Type:

```ts
type MacroExecutionStatusT =
  | "pending"
  | "running"
  | "waiting"
  | "completed"
  | "stopped"
  | "failed";

type MacroExecutionT = {
  runId: string;
  macroId: number;
  macroName?: string;
  engineType: "atem" | "tricaster" | "vmix";
  status: MacroExecutionStatusT;
  triggeredAt: number;
  startedAt: number | null;
  waitingAt: number | null;
  completedAt: number | null;
  actualDurationMs: number | null;
  loop: boolean;
  stopRequestedAt?: number | null;
  error?: string;
};
```

### Snapshot-Erweiterung im Engine-State

Empfohlene Erweiterung:

```ts
type EngineStateT = {
  status: EngineStatusT;
  type?: "atem" | "tricaster" | "vmix";
  ip?: string;
  port?: number;
  macros: MacroT[];
  macroExecution: MacroExecutionT | null;
  lastCompletedMacroExecution?: MacroExecutionT | null;
  lastUpdate?: number;
  error?: string;
};
```

Fuer ATEM reicht in v1 ein singulaeres `macroExecution`, da der Geraete-Player nur eine aktive Macro-Ausfuehrung gleichzeitig abbildet.

## Ziel-Events und Contracts

### Bridge-/Relay-Events

Empfohlene neue Bridge-Events:

- `engine_status`
- `engine_macro_execution`
- `engine_error`

Empfohlene Bedeutung:

- `engine_status`
  - Snapshot-artige Engine-Runtime-Info analog zu `graphics_status`
  - enthaelt mindestens `status`, `macros`, `macroExecution`, `lastCompletedMacroExecution`
- `engine_macro_execution`
  - feingranulares Lifecycle-Event
  - wird bei jedem Execution-Statuswechsel publiziert
- `engine_error`
  - separater Fehlerpfad analog zum bestehenden Engine-Fehlerkonzept

### Bestehende WebSocket-Events innerhalb der Bridge

Die vorhandenen internen Engine-WebSocket-Events koennen fuer Rueckwaertskompatibilitaet bleiben:

- `engine.macros`
- `engine.macroStatus`

Empfohlene Erweiterung:

- neues Event `engine.macroExecution`

### HTTP-/Command-Responses

Empfohlene Response-Erweiterungen:

- `engine_run_macro`
  - liefert direkt eine initiale Execution-Antwort zurueck
- `engine_stop_macro`
  - liefert den bekannten `macroId`, optional den aktualisierten Execution-State
- `engine_get_status`
  - liefert den vollstaendigen Runtime-Snapshot

Beispiel:

```ts
type EngineRunMacroResultT = {
  success: true;
  macroId: number;
  execution: MacroExecutionT;
  state: EngineStateT;
};
```

## Bridge-Umsetzung

### Phase 1 – ATEM-Zustandsauswertung korrigieren

Dateien:

- `apps/bridge/src/services/engine/adapters/atem-adapter.ts`
- `apps/bridge/src/services/engine-types.ts`
- `packages/protocol/src/index.ts`

Arbeitspunkte:

- `macroPlayer.isRunning` als verbindliches Signal verwenden.
- `macroPlayer.isWaiting` als eigenstaendigen Status verwenden.
- `macroPlayer.loop` in den Runtime-State aufnehmen.
- die Heuristik "nur `macroIndex` passt also `running`" entfernen.
- `macroStop()` korrekt ohne semantisch irrelevanten ID-Parameter verwenden.

Erwartetes Ergebnis:

- `running` und `waiting` sind fachlich sauber getrennt.
- ein Macro im User-Wait wird nicht mehr faelschlich als fertig interpretiert.

### Phase 2 – Execution-Tracker in der Bridge einfuehren

Empfohlene neue Datei:

- `apps/bridge/src/services/engine/engine-macro-execution-store.ts`

Verantwortung:

- aktiven Macro-Lauf halten
- `runId` vergeben
- Zeitstempel setzen
- Statusuebergaenge normalisieren
- Abschluss und Laufzeit berechnen

Empfohlene Trigger:

- `runMacro(macroId)` erzeugt `pending`
- erstes `isRunning && macroIndex===macroId` setzt `running`
- `isWaiting && macroIndex===macroId` setzt `waiting`
- Wegfall des aktiven Players nach `running|waiting` setzt `completed`
- explizites Stop mit anschliessendem Wegfall setzt `stopped`
- Fehlerpfade setzen `failed`

### Phase 3 – Engine-State und Event-Publishing erweitern

Dateien:

- `apps/bridge/src/services/engine-adapter.ts`
- `apps/bridge/src/routes/engine.ts`
- `apps/bridge/src/routes/websocket-contract.ts`
- neue Hilfsdatei `apps/bridge/src/services/engine/engine-event-publisher.ts`

Arbeitspunkte:

- `EngineStateT` um `macroExecution` und `lastCompletedMacroExecution` erweitern.
- Snapshot-Rueckgaben von `engine_get_status` anreichern.
- neue Broadcasts fuer `engine.macroExecution`.
- neue Relay-/Bridge-Events `engine_status` und `engine_macro_execution`.
- bestehende `engine.macros`/`engine.macroStatus` weiter bereitstellen.

### Phase 4 – Tests in der Bridge

Dateien:

- `apps/bridge/src/services/engine/adapters/atem-adapter.test.ts`
- `apps/bridge/src/services/engine-adapter.test.ts`
- `apps/bridge/src/routes/engine.integration.test.ts`
- `apps/bridge/src/routes/websocket-contract.test.ts`

Abzudeckende Faelle:

- Start -> Running
- Running -> Waiting
- Waiting -> Completed
- Running -> Stopped
- Loop-Macro ohne `completed`
- Resync nach reconnect
- Event-Reihenfolge bei Statuswechseln

## Relay-Integration

### Bestehender Pfad

Die Broadify-Webapp nutzt bereits:

- `POST /relay/command` fuer Commands
- Relay-WebSocket mit `webapp_subscribe`
- generische `bridge_event`-Nachrichten

Das ist bereits ausreichend fuer den neuen Macro-Feedback-Pfad.

### Empfohlene Konsequenz

Es ist wahrscheinlich keine neue Relay-Transportarchitektur noetig.

Noetig sind nur:

- neue Bridge-Event-Namen und Payloads dokumentieren
- Resync-/Snapshot-Verhalten fuer Engine erweitern
- Relay-Tests und Doku anpassen

## Broadify-Webapp – notwendige und sinnvolle Aenderungen

### 1. Engine-Typen erweitern

Datei:

- `broadify/types/engine-types.ts`

Noetige Aenderungen:

- `MacroStatusT` um `pending` und `waiting` erweitern
- `MacroExecutionStatusT` einfuehren
- `MacroExecutionT` einfuehren
- `EngineStateT` um `macroExecution` und `lastCompletedMacroExecution` erweitern
- WebSocket-/Event-Typen um `engine.macroExecution` oder Relay-Bridge-Event-Payloads erweitern

Nutzen:

- Die Webapp bekommt einen belastbaren Shared-Contract.

### 2. `bridge-commands.ts` typisieren, nicht grundlegend umbauen

Datei:

- `broadify/lib/bridge-commands.ts`

Noetige Aenderungen:

- Response-Typ fuer `engineRunMacro(...)` auf Execution-aware Result erweitern.
- Optional einen Helper fuer `engineGetStatus(...)`-Result-Typ schaerfen.

Wichtig:

- Der Transportpfad ist bereits generisch genug.
- Ein grosser Umbau der Command-API ist hier nicht noetig.

### 3. Next.js-Bridge-Command-Route nur minimal anpassen

Datei:

- `broadify/app/api/bridges/[bridgeId]/command/route.ts`

Noetige Aenderungen:

- keine strukturelle Aenderung am Forwarding
- nur Typ-/Doku-Anpassungen, falls neue Response-Felder ausgewertet werden sollen

Bewertung:

- Diese Route ist bereits generisch und blockiert den Plan nicht.

### 4. Engine-Store von Polling-only auf Snapshot + Live-Events umstellen

Datei:

- `broadify/lib/stores/engine-store.ts`

Noetige Aenderungen:

- `engineState` um `macroExecution` und `lastCompletedMacroExecution` erweitern
- Merge-Logik fuer Execution-State hinzufuegen
- Polling als Fallback/Resync beibehalten
- Live-Updates ueber Relay in denselben Store schreiben

Empfehlung:

- Polling nicht sofort entfernen
- Polling auf Recovery-Funktion reduzieren
- echte UI-Reaktivitaet ueber Events herstellen

### 5. Eigenen Relay-Hook fuer Engine-Live-Updates einfuehren

Empfohlene neue Datei:

- `broadify/hooks/use-relay-engine-updates.ts`

Vorbild:

- `broadify/hooks/use-relay-graphics-updates.ts`

Aufgaben:

- Relay-WebSocket subscriben
- `bridge_event` fuer `engine_status`, `engine_macro_execution`, `engine_error` verarbeiten
- Updates in `engine-store` schreiben

Begruendung:

- Graphics zeigt bereits das funktionierende Muster.
- Engine sollte denselben Live-Update-Mechanismus erhalten.

### 6. Controls-Macro-Store um Runtime-Bezug erweitern

Datei:

- `broadify/stores/controls-macros-store.ts`

Noetige Aenderungen:

- Makroliste nicht nur einmal laden, sondern aus dem zentralen Engine-State ableiten oder regelmaessig mit ihm synchronisieren
- aktuelle Macro-Execution fuer Controls nutzbar machen
- Default-Assignment-/Persistenzlogik weiterhin auf `MacroT[]` belassen

Wichtig:

- `controls-macros-store.ts` dient heute vor allem Auswahl, Persistenz und Session-State
- Execution-Feedback sollte nicht dort exklusiv leben
- die SSOT fuer Runtime muss der Engine-Store sein

### 7. Controls-Seite fachlich korrigieren

Datei:

- `broadify/app/(pages)/(with-nav)/dashboard/controls/page.tsx`

Aktueller Zustand:

- Der Klick auf einen Button startet `engineRunMacro(...)`
- die UI kennt nur "Request laeuft gerade"
- Erfolg bedeutet heute im Wesentlichen "Command konnte gesendet werden"

Noetige Aenderungen:

- nicht mehr sofort "Macro ausgefuehrt" als finalen Erfolg behandeln
- stattdessen:
  - beim Dispatch: optional "Makro gestartet"
  - waehrend `pending|running|waiting`: Button/Badge/Spinner
  - bei `completed`: echte Erfolgsrueckmeldung
  - bei `stopped|failed`: entsprechende Rueckmeldung
- `runningCameraActionIds` nicht nur aus dem Klick-Kontext, sondern aus Runtime-State ableiten

### 8. Benachrichtigungen inhaltlich korrigieren

Datei:

- `broadify/lib/bridge-notifications.ts`

Noetige Aenderungen:

- Trennung zwischen:
  - Command angenommen
  - Macro laeuft
  - Macro wartet
  - Macro abgeschlossen
  - Macro gestoppt
  - Macro fehlgeschlagen

Empfohlene neue Meldungstypen:

- `showMacroRunAccepted(...)`
- `showMacroRunning(...)`
- `showMacroWaiting(...)`
- `showMacroCompleted(...)`
- `showMacroStopped(...)`
- `showMacroFailed(...)`

### 9. Controls-Auswahl sinnvoll anreichern

Datei:

- `broadify/hooks/use-controls-data.ts`

Sinnvolle, aber optionale Aenderungen:

- Macro-Auswahloptionen koennen Statushinweise bekommen
- Beispiel:
  - `Intro (running)`
  - `Lower Third Reset (waiting)`

Das ist kein blocker fuer v1, verbessert aber die Bedienbarkeit deutlich.

### 10. Dashboard-/Engine-Views um Execution-Runtime erweitern

Dateien:

- Engine-bezogene Dashboard-Komponenten, die `engine-store` nutzen

Sinnvolle Aenderungen:

- aktive Macro-Ausfuehrung sichtbar machen
- `startedAt`, `actualDurationMs`, `waiting`, `loop` anzeigen
- bei `waiting` optional CTA fuer spaeteres `continue` vorbereiten

## Empfohlene UI-Semantik

### Statusdarstellung

Empfohlene fachliche Bedeutung:

- `pending`
  - Command ist angenommen, Geraet hat Start noch nicht bestaetigt
- `running`
  - ATEM bestaetigt laufenden Player
- `waiting`
  - Macro ist noch aktiv, blockiert aber in einem Wait-Zustand
- `completed`
  - Macro ist regulär fertig
- `stopped`
  - Macro wurde vorzeitig beendet
- `failed`
  - Macro konnte nicht korrekt abgeschlossen werden

### Toast-/UX-Regeln

Empfehlung:

- Kein finaler Erfolgstoast direkt nach `engine_run_macro`.
- Nur ein kurzer Hinweis "gestartet", wenn ueberhaupt.
- Finaler Erfolg erst bei `completed`.
- `waiting` als nicht-finalen Zwischenzustand behandeln.

## Security- und Betriebsaspekte

- Keine Secrets oder Tokens in Execution-Events.
- Event-Payloads klein halten.
- `macroName` ist unkritisch, aber Fehlertexte sollten nicht ungefiltert sensible Netzwerkdetails leaken.
- `lastCompletedMacroExecution` nur begrenzt vorhalten.
- Kein neuer offener Browser- oder LAN-Endpunkt fuer diesen Plan noetig.

## Migration und Rollout

### Schritt 1

- Bridge-Types und ATEM-Auswertung erweitern
- Tests fuer Runtime-Status gruen bekommen

### Schritt 2

- Execution-Store in der Bridge
- neue `engine_status`-/`engine_macro_execution`-Events

### Schritt 3

- Webapp-Typen und Engine-Store erweitern
- `use-relay-engine-updates.ts` einfuehren

### Schritt 4

- Controls-UI und Notifications auf echte Runtime umstellen

### Schritt 5

- Doku, QA und Rollout mit realem ATEM testen

## Phasenplan mit Todos

### Phase 0 – Contract festziehen

Ziel:

- Die fachlichen Zieltypen und Eventnamen werden vor der Implementierung stabilisiert.

Todos:

- [ ] `MacroStatusT` fuer Bridge und Webapp final festlegen.
- [ ] `MacroExecutionStatusT` final festlegen.
- [ ] `MacroExecutionT` fuer Shared Contract final festlegen.
- [ ] entscheiden, ob `lastCompletedMacroExecution` Teil von `EngineStateT` in v1 wird.
- [ ] Eventnamen final festlegen:
  - [ ] `engine_status`
  - [ ] `engine_macro_execution`
  - [ ] optional `engine_error`
- [ ] entscheiden, ob intern zusaetzlich `engine.macroExecution` als Bridge-WebSocket-Event eingefuehrt wird.
- [ ] Rueckwaertskompatibilitaet fuer bestehende `engine.macros` und `engine.macroStatus` dokumentieren.
- [ ] Doku-/Type-SSOT bestimmen:
  - [ ] `packages/protocol/src/index.ts`
  - [ ] `broadify/types/engine-types.ts`

### Phase 1 – Bridge Runtime korrekt machen

Ziel:

- Die Bridge soll den ATEM-Macrozustand fachlich korrekt auswerten.

Todos:

- [ ] `apps/bridge/src/services/engine/adapters/atem-adapter.ts` auf `isRunning` als Primärsignal umstellen.
- [ ] `isWaiting` in der ATEM-Auswertung berücksichtigen.
- [ ] `loop` in der ATEM-Auswertung berücksichtigen.
- [ ] die aktuelle Fallback-Heuristik entfernen, die nur bei passendem `macroIndex` bereits `running` annimmt.
- [ ] `stopMacro(...)` auf den realen `atemConnection.macroStop()`-Pfad ohne irrelevanten ID-Use anpassen.
- [ ] `apps/bridge/src/services/engine-types.ts` erweitern.
- [ ] `packages/protocol/src/index.ts` entsprechend erweitern.
- [ ] bestehende Bridge-Tests fuer `atem-adapter.ts` an die neuen Statuswerte anpassen.
- [ ] neue Tests fuer `waiting` und `loop` ergänzen.

Abnahmekriterien:

- [ ] Ein Wait-Macro wird nicht mehr als `idle` oder `completed` fehlinterpretiert.
- [ ] Ein Loop-Macro wird nicht automatisch beendet.
- [ ] Ein Macro ist nur `running`, wenn der Geraetezustand dies wirklich bestaetigt.

### Phase 2 – Execution-Store in der Bridge einfuehren

Ziel:

- Die Bridge fuehrt den Lifecycle einer Macro-Ausfuehrung als eigenen Runtime-State.

Todos:

- [ ] neue Datei `apps/bridge/src/services/engine/engine-macro-execution-store.ts` anlegen.
- [ ] `runId`-Erzeugung definieren.
- [ ] `pending`-State beim Dispatch von `runMacro(...)` setzen.
- [ ] Uebergang `pending -> running` bei bestaetigtem Geraetestart implementieren.
- [ ] Uebergang `running -> waiting` implementieren.
- [ ] Uebergang `running|waiting -> completed` implementieren.
- [ ] Uebergang `running|waiting -> stopped` implementieren.
- [ ] Uebergang `pending|running|waiting -> failed` implementieren.
- [ ] `triggeredAt`, `startedAt`, `waitingAt`, `completedAt`, `actualDurationMs` berechnen.
- [ ] `loop`-Information in den Execution-State uebernehmen.
- [ ] `lastCompletedMacroExecution` ablegen.
- [ ] Unit-Tests fuer den Execution-Store schreiben.

Abnahmekriterien:

- [ ] Ein Macro-Lauf hat einen stabilen `runId`.
- [ ] `actualDurationMs` wird nur nach Abschluss gesetzt.
- [ ] Stop und Fehler werden nicht mit `completed` vermischt.

### Phase 3 – Engine-State, HTTP und interne WS-Events erweitern

Ziel:

- Die neue Runtime wird durchgaengig aus der Bridge exponiert.

Todos:

- [ ] `apps/bridge/src/services/engine-adapter.ts` um Execution-State erweitern.
- [ ] Merge-/Broadcast-Logik in `engine-adapter.ts` anpassen.
- [ ] neues internes WS-Event `engine.macroExecution` ergänzen oder bewusst verwerfen.
- [ ] `apps/bridge/src/routes/engine.ts` Responses um `execution`/`macroExecution` ergänzen.
- [ ] `engine_get_status`-Snapshot erweitern.
- [ ] `engine_run_macro`-Response um initiale Execution-Daten ergänzen.
- [ ] `engine_stop_macro`-Response um aktualisierte Execution-Daten ergänzen.
- [ ] `apps/bridge/src/routes/websocket-contract.ts` anpassen.
- [ ] Snapshot-Builder auf neue Engine-Runtime abstimmen.
- [ ] Integrationstests fuer HTTP und WS erweitern.

Abnahmekriterien:

- [ ] `engine_get_status` liefert den neuen Runtime-State.
- [ ] `engine_run_macro` liefert einen initialen Execution-Kontext.
- [ ] interne Engine-WS-Events bleiben kompatibel oder sind sauber migriert.

### Phase 4 – Relay-/Bridge-Events fuer die Webapp bereitstellen

Ziel:

- Die Webapp erhaelt denselben Live-Mechanismus fuer Macros wie heute fuer Graphics.

Todos:

- [x] neue Datei `apps/bridge/src/services/engine/engine-event-publisher.ts` anlegen.
- [x] `engine_status` als Bridge-Event modellieren.
- [x] `engine_macro_execution` als Bridge-Event modellieren.
- [x] Publishing-Punkte in `engine-adapter.ts` integrieren.
- [x] Snapshot-/Resync-Verhalten mit Relay abgleichen.
- [x] bestehende Relay-Doku anpassen.
- [x] Tests fuer Bridge-Event-Publishing ergänzen.

Abnahmekriterien:

- [x] Relay bekommt bei Macro-Statuswechseln Live-Events.
- [x] Nach Webapp-Reconnect ist ein Resync ohne manuelle Sonderlogik moeglich.

### Phase 5 – Webapp-Typen und Engine-Store erweitern

Ziel:

- Die Webapp kann den neuen Macro-Runtime-State vollstaendig modellieren.

Todos:

- [x] `broadify/types/engine-types.ts` erweitern:
  - [x] `MacroStatusT`
  - [x] `MacroExecutionStatusT`
  - [x] `MacroExecutionT`
  - [x] `EngineStateT`
  - [x] WebSocket-/Event-Typen
- [x] `broadify/lib/bridge-commands.ts` Response-Typen fuer `engineRunMacro`/`engineStopMacro` schaerfen.
- [x] `broadify/lib/stores/engine-store.ts` um `macroExecution` und `lastCompletedMacroExecution` erweitern.
- [x] Merge-Logik fuer Execution-State in `engine-store.ts` ergänzen.
- [x] Polling als Resync-/Fallbackpfad beibehalten.
- [x] Tests fuer `engine-store.ts` erweitern.

Abnahmekriterien:

- [x] Die Webapp kennt den Runtime-State typsicher.
- [x] Polling zerstoert keine Live-Events.

### Phase 6 – Relay-Live-Updates fuer Engine in der Webapp einbauen

Ziel:

- Die Webapp soll Engine-/Macro-Live-Updates ueber Relay konsumieren.

Todos:

- [ ] neue Datei `broadify/hooks/use-relay-engine-updates.ts` anlegen.
- [ ] WebSocket-Subscription analog zu `use-relay-graphics-updates.ts` umsetzen.
- [ ] `bridge_event` fuer `engine_status` verarbeiten.
- [ ] `bridge_event` fuer `engine_macro_execution` verarbeiten.
- [ ] Updates in `engine-store` schreiben.
- [ ] Reconnect-/Backoff-Logik von Graphics uebernehmen oder abstrahieren.
- [ ] entscheiden, ob Graphics- und Engine-Relay-Hooks spaeter vereinheitlicht werden sollen.
- [ ] Tests fuer den neuen Hook ergänzen.

Abnahmekriterien:

- [ ] Macro-Live-Updates kommen ohne Polling-Verzoegerung in der Webapp an.
- [ ] Reconnect fuehrt nicht zu doppelten oder verlorenen States.

### Phase 7 – Controls-Macro-Flow in der Webapp auf Runtime umstellen

Ziel:

- Die Controls-Seite soll echtes Ausfuehrungsfeedback anzeigen statt nur Command-Dispatch.

Todos:

- [ ] `broadify/stores/controls-macros-store.ts` so anpassen, dass Runtime nicht die SSOT dieses Stores wird.
- [ ] die Makroliste weiterhin fuer Auswahl/Persistenz nutzbar halten.
- [ ] laufende Macro-Aktionen aus dem `engine-store` in die Controls-UI spiegeln.
- [ ] `broadify/app/(pages)/(with-nav)/dashboard/controls/page.tsx` anpassen:
  - [ ] Dispatch-Loading und Runtime-Status trennen
  - [ ] `pending`
  - [ ] `running`
  - [ ] `waiting`
  - [ ] `completed`
  - [ ] `stopped`
  - [ ] `failed`
- [ ] `runningCameraActionIds`-Logik ueberarbeiten.
- [ ] `broadify/hooks/use-controls-data.ts` optional um Statuslabels fuer Auswahloptionen erweitern.
- [ ] Controls-Tests anpassen.

Abnahmekriterien:

- [ ] Ein Button zeigt nicht nur "Request laeuft", sondern den realen Runtime-Status.
- [ ] Ein Wait-Macro bleibt sichtbar aktiv.
- [ ] Finaler Erfolg erscheint erst bei echtem Abschluss.

### Phase 8 – Notifications und UX-Semantik korrigieren

Ziel:

- Die Benutzerkommunikation soll fachlich stimmen.

Todos:

- [ ] `broadify/lib/bridge-notifications.ts` um Completion-aware Notifications erweitern.
- [ ] Soforterfolg nach `engine_run_macro` entfernen oder in "gestartet" umbenennen.
- [ ] neue Meldungstypen einführen:
  - [ ] `showMacroRunAccepted(...)`
  - [ ] `showMacroRunning(...)`
  - [ ] `showMacroWaiting(...)`
  - [ ] `showMacroCompleted(...)`
  - [ ] `showMacroStopped(...)`
  - [ ] `showMacroFailed(...)`
- [ ] deutsche und englische Texte fachlich angleichen.
- [ ] Doppelte Toasts bei Store- und View-Logik vermeiden.

Abnahmekriterien:

- [ ] Nutzer sehen keinen falschen Abschluss-Toast direkt nach Dispatch.
- [ ] `waiting` wird als Zwischenzustand und nicht als Fehler dargestellt.

### Phase 9 – Dokumentation, QA und Realgeraete-Test

Ziel:

- Der Plan ist nicht nur implementiert, sondern sauber dokumentiert und mit echtem ATEM verifiziert.

Todos:

- [ ] diese Doku nach Code-Implementierung auf Ist-Stand aktualisieren.
- [ ] `docs/integration/interfaces.md` anpassen.
- [ ] weitere betroffene Dokus fuer Relay-/Engine-Contracts anpassen.
- [ ] QA-Runbook fuer echte ATEM-Macros ergänzen.
- [ ] Testmatrix fuer folgende Faelle dokumentieren:
  - [ ] normales Macro
  - [ ] Wait-Macro
  - [ ] Stop waehrend Run
  - [ ] Loop-Macro
  - [ ] Bridge-Reconnect
  - [ ] Webapp-Reconnect
- [ ] Realgeraete-Test mit mindestens einem ATEM dokumentieren.

Abnahmekriterien:

- [ ] Alle Pflichtfaelle sind mit echtem Geraet oder belastbarer Simulation verifiziert.
- [ ] Doku und Code widersprechen sich nicht.

## Kompakte Abarbeitungsreihenfolge

- [ ] Phase 0 – Contract festziehen
- [ ] Phase 1 – Bridge Runtime korrekt machen
- [ ] Phase 2 – Execution-Store in der Bridge einfuehren
- [ ] Phase 3 – Engine-State, HTTP und interne WS-Events erweitern
- [x] Phase 4 – Relay-/Bridge-Events fuer die Webapp bereitstellen
- [x] Phase 5 – Webapp-Typen und Engine-Store erweitern
- [ ] Phase 6 – Relay-Live-Updates fuer Engine in der Webapp einbauen
- [ ] Phase 7 – Controls-Macro-Flow in der Webapp auf Runtime umstellen
- [ ] Phase 8 – Notifications und UX-Semantik korrigieren
- [ ] Phase 9 – Dokumentation, QA und Realgeraete-Test

## QA-Checkliste

- Macro startet und wird als `running` sichtbar
- Macro mit internem Wait wird als `waiting` sichtbar
- Macro mit Wait springt nicht verfrueht auf Erfolg
- Macro endet und liefert `completedAt` und `actualDurationMs`
- Macro-Stop fuehrt zu `stopped`
- Loop-Macro bleibt aktiv, bis Stop erfolgt
- Reload der Webapp zeigt ueber Snapshot den aktuellen Execution-State korrekt
- Relay-Reconnect fuehrt zu korrektem Resync
- Controls-Buttons zeigen keinen falschen Finalerfolg direkt nach Dispatch

## Konkrete Datei-Liste fuer die Implementierung

Bridge:

- `packages/protocol/src/index.ts`
- `apps/bridge/src/services/engine-types.ts`
- `apps/bridge/src/services/engine/adapters/atem-adapter.ts`
- `apps/bridge/src/services/engine-adapter.ts`
- `apps/bridge/src/routes/engine.ts`
- `apps/bridge/src/routes/websocket-contract.ts`
- `apps/bridge/src/services/engine/engine-macro-execution-store.ts`
- `apps/bridge/src/services/engine/engine-event-publisher.ts`
- zugehoerige Tests

Broadify-Webapp:

- `broadify/types/engine-types.ts`
- `broadify/lib/bridge-commands.ts`
- `broadify/lib/stores/engine-store.ts`
- `broadify/hooks/use-relay-engine-updates.ts`
- `broadify/stores/controls-macros-store.ts`
- `broadify/app/(pages)/(with-nav)/dashboard/controls/page.tsx`
- `broadify/lib/bridge-notifications.ts`
- optional weitere Engine-/Dashboard-Komponenten

## Entscheidung

Die empfohlene Umsetzung ist:

- Bridge-seitig ein echtes Macro-Execution-Modell einfuehren
- Webapp-seitig Snapshot und Relay-Live-Events kombinieren
- UI-seitig Dispatch-Erfolg und echte Completion strikt trennen

Das ist die sauberste Erweiterung, weil sie:

- auf den realen ATEM-States aufsetzt,
- zum bestehenden Graphics-Muster passt,
- den bestehenden Relay-/Commandpfad weiterverwendet,
- und sowohl Bridge als auch Webapp mit minimalem Architekturbruch erweitert.
