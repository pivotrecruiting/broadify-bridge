# Session-Log (Post-Production Live-Adapter)

Schreibt während einer Aufnahme ein `SessionEventLog` (JSONL, eine Datei pro Aufnahme), das die Post-Production
nutzt, um Grafik- und Kamerafenster exakt statt per Bildheuristik zu kennen. Vertrag: `session-log-types.ts`
(Spiegel von `broadify-postpro/postpro/contracts/models.py`, `session_event_log`). Architektur: ADR 0008 im
Repo `broadify-postpro`.

## Stand (2026-10-10)

- `session-log-types.ts`: zod-Schema für Ereignisse und Sitzungskopf.
- `session-event-recorder.ts`: Sitzung öffnet bei `recording_started`, schließt bei `recording_stopped`,
  schreibt beim Start einen Snapshot dessen, was gerade on air ist; Fehler werden geschluckt (nie im Hot Path).
- `atem-state-diff.ts`: reine Funktion aus zwei `atem-connection`-Zuständen → Ereignisse (Program/Preview je M/E,
  USK/DSK on air, Recording/Streaming mit Dauer-Timecode). `atem-connection` 2.5 liefert keinen Haus-Timecode.
- `EngineAdapter.onSwitcherEvent` (optional) in `engine-adapter-interface.ts`.
- **ATEM (IP) verdrahtet**: `atem-adapter.ts` hält einen Snapshot (`snapshotAtemState`, weil `atem-connection` seinen
  Zustand in-place ändert), ruft `diffAtemState` im `stateChanged`-Handler und reicht Ereignisse an `onSwitcherEvent`-
  Abonnenten; Makro-Steuerung bleibt unberührt, Fehler werden geschluckt.
- `session-log-service.ts`: Recorder-Singleton unter `<userData>/session-log`, `recordSwitcherEvent` als Senke.
  `EngineAdapterService` abonniert beim Verbinden (`deps.switcherEventSink`, in Tests austauschbar) und meldet
  sich beim Trennen ab.
- Replay-Fixture `fixtures/atem-replay-basic.json` und Tests.

- **ATEM-Timecode**: `atem-connection` 2.5 liefert keinen Timecode-Strom, antwortet aber auf `requestTime()` mit
  `state.info.lastTime`. Der Adapter fragt einmal pro Sekunde, `atem-timecode.ts` rechnet Lesung + Wanduhr-Differenz
  in `hh:mm:ss:ff` um (Framerate aus `settings.videoMode`). Jedes Ereignis trägt diesen Haus-Timecode; ohne Lesung
  bleibt der Aufnahme-Dauer-Timecode aus dem Diff.
- **vMix**: zusätzlich zur HTTP-Abfrage (2 s, Makros) ein TCP-Abo auf Port 8099 (`SUBSCRIBE ACTS`,
  `vmix-activators-client.ts`): Program/Preview, Overlays 1–4, Recording, Streaming in Echtzeit; Eingangsnamen aus
  der Inputs-Liste. Verbindungsfehler werden still wiederholt und erreichen nie den Engine-Status.
- **RØDECaster Video**: `/show/pgmcurrent`, `/show/PgmOverlay`, `/show/record`, `/show/live` werden als Ereignisse
  gemeldet (`input_id` = `scene:3`, `media:2`, `videoIn:1`).
- **Grafiken**: `GraphicsManager` meldet `graphic_shown/updated/hidden` für alle Ebenen (Studio und Meeting) mit
  Template-ID (Preset oder Kategorie) und den Textfeldern (`fields`, Strings ≤ 500 Zeichen). Der bestehende
  Usage-Recorder (Abrechnung, nur Meeting) bleibt unverändert.

## Noch nicht verdrahtet

ATEM USB (C++-Helper-Callbacks); Meeting-Program-Wechsel (Auto-Director) als Ereignis; Upload über den
Relay-Broker (Muster `ci_*`) und Ingest per Definer-RPC.
