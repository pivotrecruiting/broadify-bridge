# ADR-0008: Session-Event-Log nur auf Opt-in

- Status: akzeptiert
- Datum: 2026-11-19

## Kontext
Das Session-Event-Log (`apps/bridge/src/services/session-log/`) schreibt während einer Aufnahme mit, was am Mischer
und in den Grafiken passiert, und lädt die Datei danach zur Post-Production-Plattform hoch. Im ersten Stand lief die
Erfassung auf jeder Bridge mit, sobald ein Mischer verbunden war; nur der Upload hing an der PostPro-URL. Das hatte
Nebenwirkungen auf Geräten, die mit Post-Production nichts zu tun haben:
- der ATEM wurde einmal pro Sekunde nach der Uhrzeit gefragt (`requestTime()`), und jeder Zustandswechsel wurde kopiert
  und verglichen;
- zu vMix wurde eine zweite Verbindung geöffnet (TCP 8099, `SUBSCRIBE ACTS`);
- die Textfelder der Grafiken on air (Namen, Titel) und der Programmverlauf des Meetings landeten unter
  `<userData>/session-log` auf der Platte, ohne Aufbewahrungsgrenze;
- eine fehlerhafte `POSTPRO_API_URL` hat den Start der Bridge verhindert (`ConfigSchema.parse`).

Gabriel (19.11.2026): standardmäßig aus.

## Entscheidung
- **Ein Schalter:** `isSessionLogEnabled()` in `session-log-service.ts`. Er ist genau dann wahr, wenn die Bridge mit
  einer PostPro-URL gestartet wurde (`--postpro-api-url` bzw. `POSTPRO_API_URL`). Es gibt kein zweites Flag.
- **Ohne URL ist das Feature vollständig untätig:** kein Recorder, kein Ordner `session-log`, kein Timer, kein Upload,
  keine Aufbewahrungsläufe. `getSessionEventRecorder()` liefert `null`, `recordSwitcherEvent()` tut nichts.
- **Die Adapter arbeiten nur für Zuhörer.** `EngineAdapterService` abonniert `onSwitcherEvent` nur bei eingeschaltetem
  Feature. ATEM-Zeitabfrage, Zustandskopie und die vMix-Verbindung auf 8099 starten mit dem ersten Abonnenten und enden
  mit dem letzten. Die Adapter selbst kennen den Schalter nicht.
- **Grafik- und Meeting-Pfad kehren früh zurück** (`recordSessionGraphic`, `recordSessionEvents`), bevor Textfelder
  oder der Meeting-Status gelesen werden.
- **Die URL kann den Start nicht mehr verhindern:** `normalizePostproApiUrl()` (`config.ts`) lässt nur `http(s)`-URLs
  durch; alles andere wird mit einer festen Warnung ohne den Wert verworfen, das Feature bleibt aus.
- **Aufbewahrung** (`session-log-retention.ts`, nur bei eingeschaltetem Feature): nicht hochgeladene Sitzungen 30 Tage,
  hochgeladene 7 Tage nach dem Marker `.uploaded.json`, höchstens 200 Sitzungsdateien, nie die offene Sitzung. Läufe:
  beim Start des Dienstes, nach jedem Sitzungsende, vor jedem periodischen Upload-Scan.
- **Kein Release schaltet es ein:** die URL ist kein release-verwalteter Schlüssel und steht in keiner gepackten
  `.env` (`scripts/session-log-opt-in-contract.test.cjs`). Der Weg in die Bridge ist die Umgebung der Desktop-App
  (`userData/.env` oder Shell), die unverändert an den Bridge-Prozess geht (`bridge-process-contract.ts`).

## Alternativen
- **Eigenes Flag** (`BRIDGE_SESSION_LOG=1`) neben der URL: zwei Schalter, von denen einer allein nichts Sinnvolles
  tut (Logs ohne Ziel). Verworfen.
- **Lokal immer mitschreiben, nur den Upload schalten** (bisheriger Stand): lässt Polling, zweite Verbindung und
  Texte auf der Platte auf jeder Bridge. Verworfen.
- **Schalter in den Adaptern abfragen:** koppelt Mischer-Adapter an die Bridge-Konfiguration. Die Zuhörer-Regel
  erreicht dasselbe und hält die Adapter testbar.

## Folgen
- Bridges ohne PostPro-URL verhalten sich am Mischer wie vor dem Feature (festgenagelt in
  `session-log-inert.test.ts`).
- Mit URL, aber ohne Bridge-ID (Relay nicht eingerichtet) wird lokal aufgezeichnet und nicht hochgeladen; die Bridge
  meldet das einmal im Log.
- Das Einschalten braucht einen Neustart der Bridge; der Schalter wird beim Start gelesen.
- Ein Log, das 30 Tage lang nicht hochgeladen werden konnte, geht verloren. Das ist gewollt: die Datei enthält
  On-Air-Texte und soll nicht unbegrenzt liegen.
- Ein später Abonnent an einem bereits verbundenen ATEM bekommt als erstes Ereignis den vollen Ist-Zustand
  (Program/Preview je M/E, Keyer on air), nicht nur die nächste Änderung.
