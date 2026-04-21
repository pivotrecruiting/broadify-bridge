# ATEM Macro Feedback – QA Runbook

## Ziel
Dieses Runbook beschreibt die Abnahme des ATEM-Macro-Feedback-Pfads von der Bridge bis zur Broadify-Webapp.

Der Test gilt als bestanden, wenn die Webapp nicht nur den Dispatch eines Macros bestaetigt, sondern den echten Geraete-Lifecycle anzeigt:

- `pending`
- `running`
- `waiting`
- `completed`
- `stopped`
- `failed`

## Voraussetzungen

- Ein echter ATEM-Switcher im Netzwerk oder eine belastbare Simulation der `atem-connection`-State-Events.
- Bridge V2 laeuft und ist mit Relay verbunden.
- Broadify-Webapp ist mit derselben Bridge gepairt.
- In der Webapp ist die Engine als `atem` verbunden.
- Mindestens vier ATEM-Macros sind vorbereitet:
  - normales Macro mit sichtbarer Laufzeit
  - Macro mit User-Wait / Wait-Schritt
  - Loop-Macro
  - Macro, das lange genug laeuft, um Stop waehrend Run zu testen

## Beobachtungspunkte

- Bridge HTTP:
  - `engine_get_status`
  - `engine_get_macros`
  - `engine_run_macro`
  - `engine_stop_macro`
- Bridge lokale WS-Events:
  - `engine.macroExecution`
  - `engine.macros`
  - `engine.macroStatus`
- Relay Bridge-Events:
  - `engine_status`
  - `engine_macro_execution`
  - `engine_error`
  - `engine_status_snapshot`
- Webapp:
  - `engine-store`
  - Controls-Button Runtime-Label
  - Macro-Lifecycle-Toasts

## Testmatrix

| Fall | Setup | Schritte | Erwartung Bridge | Erwartung Webapp |
| --- | --- | --- | --- | --- |
| Normales Macro | ATEM-Macro ohne Wait, nicht Loop | Macro in Controls ausloesen | `pending -> running -> completed`, `completedAt` und `actualDurationMs` gesetzt | Button zeigt `running`, danach `completed`; Completion-Toast erst bei Abschluss |
| Wait-Macro | Macro enthaelt Wait/User-Wait | Macro ausloesen und nicht sofort fortsetzen | `pending -> running -> waiting`, kein fruehes `completed` | Button bleibt sichtbar aktiv mit `waiting`; kein Fehler-Toast |
| Wait-Macro fortsetzen | Wait-Macro wartet bereits | Macro am ATEM fortsetzen | `waiting -> completed`, `actualDurationMs` gesetzt | Button zeigt `completed`; Abschluss-Toast erscheint einmal |
| Stop waehrend Run | lang laufendes Macro | Macro ausloesen, dann Stop aus Webapp oder ATEM | `running|waiting -> stopped`, `stopRequestedAt` falls Webapp-Stop | Button zeigt `stopped`; Stopped-Toast erscheint einmal |
| Loop-Macro | Loop im ATEM aktiv | Loop-Macro ausloesen und laufen lassen | bleibt `running`, `loop: true`, kein automatisches `completed` | Button bleibt aktiv; kein Abschluss-Toast bis Stop |
| Bridge-Reconnect | Macro laeuft oder wartet | Bridge-Prozess/Netz kurz unterbrechen, dann reconnect | nach `bridge_auth_ok` kommt `engine_status_snapshot`; aktive Execution bleibt im Snapshot sichtbar, sofern ATEM-State noch aktiv ist | Webapp synchronisiert ohne manuelles Refresh; Button-Status bleibt korrekt |
| Webapp-Reconnect | Macro laeuft oder wartet | Webapp neu laden oder Relay-WS trennen | Relay liefert Snapshot + neue Live-Events | Kein stale Toast beim Initialrender; Live-Status ist sichtbar |
| Fehlerfall | ATEM nicht erreichbar oder Macro-Command scheitert | Macro ausloesen oder Engine trennen | `engine_error` bzw. `failed` mit `error` | Error-/Failed-Toast erscheint; kein Completed-Toast |

## Detailpruefungen

### HTTP Snapshot
1. `engine_get_status` ausfuehren.
2. Erwartung:
- `state.macroExecution` ist `null` oder enthaelt den aktiven Lauf.
- `state.lastCompletedMacroExecution` enthaelt den letzten finalen Lauf.
- Finaler Lauf hat `completedAt` und `actualDurationMs`.

### Relay Live-Events
1. Webapp mit Relay verbinden.
2. Macro ausloesen.
3. Erwartung:
- `engine_status` wird bei relevanten Engine-/Macro-State-Aenderungen publiziert.
- `engine_macro_execution` wird bei Lifecycle-Aenderungen publiziert.
- Nach Relay-Reconnect erscheint `engine_status_snapshot`.

### Controls UX
1. Macro ueber Controls-Button ausloesen.
2. Erwartung:
- Sofort-Toast lautet nur gestartet/accepted.
- `running`/`waiting` werden als Zwischenstatus angezeigt.
- `completed`, `stopped` oder `failed` erscheinen erst aus Runtime-Events.
- Doppelte Toasts fuer denselben `runId:status` erscheinen nicht.

## Realgeraete-Testprotokoll

Bei einem Test mit echtem ATEM folgende Daten dokumentieren:

- Datum / Uhrzeit
- ATEM-Modell und Firmware-Version
- Bridge-Version / Commit
- Webapp-Version / Commit
- Netzwerkpfad: lokal, Relay, VPN, WLAN/LAN
- getestete Macro-IDs und Namen
- Ergebnis je Testmatrix-Zeile
- Abweichungen, Logs oder Screenshots

## Status

Implementierung und automatisierte Tests sind abgeschlossen. Der echte Realgeraete-Test muss pro Release mit mindestens einem ATEM dokumentiert werden. Bis dieser Test protokolliert ist, gilt Phase 9 fachlich als dokumentiert, aber hardwareseitig als noch nicht realgeraete-verifiziert.
