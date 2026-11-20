# Session-Event-Log (Post-Production)

Die Bridge kann während einer Aufnahme mitschreiben, was am Mischer und in den Grafiken passiert, und die Datei
danach zur Post-Production-Plattform hochladen. Die Post-Production kennt Kamera- und Grafikfenster damit exakt statt
per Bildheuristik.

**Standardmäßig aus.** Entscheidung und Begründung: [ADR-0008](../architecture/adr/0008-session-event-log-nur-auf-opt-in.md).
Modul und Vertrag: `apps/bridge/src/services/session-log/` (README dort).

## Einschalten

Es gibt genau einen Schalter: die Basis-URL der Web-App.

| Weg | Wert |
|---|---|
| CLI der Bridge | `--postpro-api-url https://<web-app>` |
| Umgebung | `POSTPRO_API_URL=https://<web-app>` |

- In der Desktop-App: `POSTPRO_API_URL` in `userData/.env` eintragen (oder in der Shell setzen) und die App neu
  starten. Die Desktop-App reicht ihre Umgebung unverändert an den Bridge-Prozess weiter. Eine Einstellung in der
  Oberfläche gibt es nicht.
- Die CLI gewinnt vor der Umgebung. Ist der CLI-Wert unbrauchbar, gilt die Umgebung.
- Erlaubt sind nur `http://`- und `https://`-URLs. Ein leerer Wert zählt als nicht gesetzt. Ein fehlerhafter Wert
  wird mit einer Warnung (ohne den Wert) verworfen; die Bridge startet trotzdem, das Feature bleibt aus.
- Kein Release setzt die URL: sie ist nicht release-verwaltet und steht in keiner gepackten `.env`.

Im Bridge-Log steht bei eingeschaltetem Feature einmal `[SessionLog] enabled` (ohne URL). Fehlt die Bridge-ID
(Relay nicht eingerichtet), folgt einmal der Hinweis, dass nur lokal aufgezeichnet und nicht hochgeladen wird.

## Was ohne URL passiert

Nichts:

- kein Ordner `<userData>/session-log`, kein Recorder, keine Timer, kein Netzwerkzugriff;
- ATEM: keine Zeitabfrage (`requestTime()`), keine Zustandskopie, kein Vergleich;
- vMix: keine zweite Verbindung auf TCP 8099; die HTTP-Abfrage für Makros läuft wie immer;
- Grafiken und Meeting: Textfelder und Status werden für das Log nicht gelesen.

Makro-Steuerung, Engine-Status und der Usage-Recorder (Abrechnung) sind davon unabhängig und unverändert.

## Was mit URL passiert

| Quelle | Ereignisse | Zusatzlast |
|---|---|---|
| ATEM (IP) | Program/Preview je M/E, USK/DSK, Recording, Streaming, Haus-Timecode | Zeitabfrage 1×/s, Zustandskopie je Änderung |
| vMix | Program/Preview, Overlays 1–4, Recording, Streaming | zweite Verbindung TCP 8099 (`SUBSCRIBE ACTS`), Eingangsnamen |
| RØDECaster Video | Szene/Overlay, Record, Live | keine |
| Grafiken (Studio, Meeting) | `graphic_shown/updated/hidden` mit Template-ID und Textfeldern (≤ 500 Zeichen je Feld) | keine |
| Meeting | Aufnahme Start/Stopp, Programmwechsel | keine |

Die Adapter liefern nur, solange jemand zuhört: Zeitabfrage und zweite Verbindung beginnen mit dem ersten
Abonnenten und enden mit dem letzten. Im Betrieb ist `EngineAdapterService` der einzige Abonnent, vom Verbinden bis
zum Trennen des Mischers.

Eine Sitzung beginnt mit `recording_started` und endet mit `recording_stopped`. Außerhalb einer Aufnahme wird nichts
geschrieben; der Recorder merkt sich nur, was gerade on air ist, um die nächste Sitzung mit einem Snapshot zu beginnen.

## Dateien und Aufbewahrung

- `<userData>/session-log/<session_id>.jsonl`: Kopfzeile, dann ein Ereignis je Zeile.
- `<userData>/session-log/<session_id>.uploaded.json`: Marker nach erfolgreichem Upload.
- Der Ordner entsteht mit der ersten Sitzung, nicht schon beim Einschalten.

| Regel | Grenze |
|---|---|
| nicht hochgeladen | 30 Tage nach der letzten Änderung der Datei |
| hochgeladen | 7 Tage nach dem Marker (Datei und Marker zusammen) |
| Anzahl | höchstens 200 Sitzungsdateien, älteste zuerst |
| offene Sitzung | wird nie gelöscht |

Aufgeräumt wird beim Start, nach jedem Sitzungsende und vor jedem periodischen Upload-Scan (alle 10 Minuten),
ausschließlich bei eingeschaltetem Feature. Wird das Feature wieder ausgeschaltet, bleiben vorhandene Dateien liegen
und müssen von Hand gelöscht werden.

## Upload

Nach `recording_stopped` direkt an die Web-App, signiert mit dem Enrollment-Schlüssel der Bridge:
`POST /api/postpro/bridge/sessions/upload-url` → `PUT` auf die Signed URL → `POST /api/postpro/bridge/sessions/complete`.
Fehlversuche werden geloggt, je Datei auf fünf Versuche pro Scan-Runde begrenzt und beim nächsten Scan wiederholt.
Der Upload braucht eine Bridge-ID; ohne sie bleiben die Dateien lokal.

## Datenschutz

Die Dateien enthalten die Textfelder der Grafiken on air (zum Beispiel Namen in Bauchbinden) und Eingangsnamen des
Mischers. Deshalb: aus ohne ausdrückliche Konfiguration, begrenzte Aufbewahrung, URL und Feldinhalte nie im Bridge-Log.

## Tests

- `session-log-inert.test.ts`: ohne URL kein Ordner, kein Abonnement, keine ATEM-Zeitabfrage, kein Socket auf 8099.
- `session-log-retention.test.ts`, `session-log-service.test.ts`, `session-log-uploader.test.ts`.
- `atem-adapter.test.ts`, `vmix-adapter.test.ts`: Start mit dem ersten, Stopp mit dem letzten Abonnenten.
- `config.test.ts`: URL-Normalisierung.
- `bridge-process-contract.test.ts`, `scripts/session-log-opt-in-contract.test.cjs`: Weg der URL in die Bridge, kein
  Release setzt sie.
