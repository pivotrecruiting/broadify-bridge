# Bridge Feature – Mode-Aktivierung (`mode_activate`)

## Warum
Die Bridge kennt die Modi Studio/Meeting/Conference nicht; `config.mode` in
`routes/status.ts` ist die Laufzeitumgebung. Die Modusauswahl ist die
Startseite der Web-App (`/studio|/dashboard`, `/meeting`, `/conference`).

Feldbefund (rc.19, Windows, Meeting-Modus, 27.10.): Bei jedem Bridge-Start
stellte die Bridge Studio-Zustand wieder her, obwohl der Anwender im Meeting
war:

1. `startPersistedAutoConnect()` in `startServer()` verband nach 3 s die
   persistierte ATEM (unerreichbar) → 4 × `CONNECTION_TIMEOUT` in ~60 s, jeder
   als `engine_error`-Bridge-Event → Fehler-Toasts in der Web-App.
2. `graphicsManager.initialize()` wandte die persistierte Output-Config
   `video_hdmi` an; ohne angeschlossenes Display fand die Adapter-Factory keinen
   Port und fiel auf `DecklinkVideoOutputAdapter` zurück → auf Windows
   „DeckLink helper not executable", Supervisor-Retries, „Recovery attempts
   exhausted".

Entscheidung (27.10.): Die Web-App sagt der Bridge, in welchem Modus sie ist;
nur dann stellt die Bridge Studio-Verbindungen wieder her.

## Command `mode_activate`
Allowlist/Policy: `relay-command-allowlist.ts`, `relay-command-policy.ts`
(Side-Effect, Timeout-Klasse `engine_connect` 18 s / 17 s, Lane `mode`,
`after_state_check`). Schema `ModeActivateSchema` in
`relay-command-schemas.ts` (strict).

Payload:
```json
{ "mode": "studio" }
```
`mode` ∈ `studio | meeting | conference`; unbekannte Modi oder zusätzliche
Keys → `command_result` mit `error: "Invalid payload for mode_activate: …"`.

Antwort (success):
```json
{
  "success": true,
  "data": { "mode": "studio", "restored": ["engine_autoconnect", "graphics_output"] }
}
```
`restored` listet, was **angestoßen** wurde, nicht was gelungen ist. Die
Ergebnisse kommen über die bestehenden Wege: `engine_status` / `engine_error`
(Bridge-Events) bzw. `graphics_status` / `graphics_error` und `get_status`.

Protocol-Typen: `BridgeModeT`, `ModeActivationRestoreTargetT`,
`ModeActivateResultT` in `packages/protocol/src/index.ts`.

## Was je Modus wiederhergestellt wird
| Modus | Engine-Auto-Connect | Persistierte Graphics-Output-Config | `restored` |
| --- | --- | --- | --- |
| `studio` | ja (`engineAdapter.startPersistedAutoConnect()`, 3 s Delay, 5 Versuche) | ja (`graphicsManager.applyPersistedOutput()`) | `["engine_autoconnect", "graphics_output"]` |
| `conference` | ja | ja (Display-Output der Konferenz startet weiterhin der Conference-Flow der Web-App) | `["engine_autoconnect", "graphics_output"]` |
| `meeting` | nein | nein | `[]` |

Beide Restores sind idempotent:
- `startPersistedAutoConnect()` ist ein No-op, solange ein Startversuch
  pending ist, ein Connect läuft oder die Engine nicht `disconnected` ist.
- `applyPersistedOutput()` ist ein No-op, wenn bereits ein Output konfiguriert
  ist, der Output-Supervisor gerade einen fehlgeschlagenen Apply recovert oder
  ein Apply in Flight ist (parallele Aufrufer teilen sich das Promise).

Damit darf der Command beliebig oft und von mehreren Clients gesendet werden
(Reload, zweiter Browser, Relay-Replay). Die aktivierten Modi werden als Set
in `ModeActivationState` geführt (`apps/bridge/src/services/mode/`).

## Kein automatischer Studio-Restore beim Bridge-Start
- `startServer()` ruft `startPersistedAutoConnect()` nicht mehr auf.
- `graphicsManager.initialize()` lädt und loggt die persistierte Output-Config
  (`[Graphics] Loaded persisted runtime state …`), wendet sie aber nicht an.
  Renderer-Init, Asset-Registry und Usage-Recorder laufen unverändert.
- Die Reihenfolge „Device-Module vor `graphicsManager.initialize()`" in
  `server.ts` bleibt relevant: der spätere Apply löst den Ziel-Port über den
  Device-Cache auf.
- Erst `applyPersistedOutput()` konfiguriert Renderer-Session, FrameBus und
  Output-Adapter – mit derselben Fehlerbehandlung wie der frühere Startup-Apply:
  Bei Fehler bleibt die persistierte Config erhalten, Stub-Adapter aktiv,
  `graphics_error` + `graphics_status(output_error)`, Supervisor startet mit
  `init_failed` (Backoff 2 s → 60 s, max. 6 Versuche, danach Warten auf
  Device-Change). Bei Erfolg wird `graphics_status` mit `reason:
  outputs_configured` veröffentlicht, weil jetzt – anders als beim Start –
  Clients verbunden sind.

## `engine_error` nur bei aktivem Modus
`EngineAdapterService` merkt sich, ob gerade der persistierte Startup-Restore
läuft (`startupRestoreActive`, über alle Supervisor-Retries hinweg). Schlägt
der Restore fehl und ist kein Studio-/Conference-Modus aktiviert
(`ModeActivationState.isStudioRestoreActive()`), wird **kein** `engine_error`
Bridge-Event gesendet, sondern eine Info-Zeile geloggt:
`[Engine] Startup restore failed, no Studio/Conference mode active; engine_error not published: …`.
Lokaler Engine-State und WebSocket-Broadcast (`engine.error`) bleiben
unverändert, ebenso `engine_status`.

Weiterhin veröffentlicht werden Fehler
- manueller Connects (`engine_connect`), auch wenn sie einen laufenden Restore
  „joinen",
- des Restores, sobald `studio` oder `conference` aktiviert wurde.

## Kein DeckLink-Fallback für Display-Targets
`selectOutputAdapter()` wirft für `video_hdmi` ohne auffindbaren Port einen
`GraphicsError` mit Code `output_device_not_found` („Display output `<id>` is
not connected") statt den DeckLink-Adapter zurückzugeben. Der Apply hält die
Config, der Supervisor wartet mit begrenztem Backoff auf den Device-Change.
Ein HDMI-Port, der im Cache zu einem DeckLink-Gerät gehört, bleibt DeckLink.
Siehe `docs/integration/error-catalog.md`.

## Capability
`get_status.data.capabilities.mode_activation: true`. Die Web-App sendet
`mode_activate` nur, wenn die Capability vorhanden ist; ältere Bridges kennen
den Command nicht (Allowlist-Fehler) und restaurieren Studio weiterhin selbst
beim Start.

## Rollout
1. **Web-App zuerst**: Sie sendet `mode_activate` nach der Modusauswahl (und
   nach jedem Reconnect/Reload, der Command ist idempotent) – gegen alte
   Bridges harmlos, weil die Capability fehlt.
2. Dann die Bridge. **Alte Web-App + neue Bridge** bedeutet: Nach einem
   Bridge-Neustart gibt es **keinen automatischen Studio-Restore** mehr – weder
   ATEM-Auto-Connect noch persistierte Output-Config – bis die Web-App
   `mode_activate` sendet oder der Anwender manuell verbindet bzw. Outputs
   konfiguriert.

## Tests
- `apps/bridge/src/services/mode/mode-activation-service.test.ts`
- `apps/bridge/src/services/mode/mode-activation-state.test.ts`
- `apps/bridge/src/services/command-router.test.ts` (`mode_activate`, Capability)
- `apps/bridge/src/services/command-router-security.test.ts` (Schema)
- `apps/bridge/src/services/engine-adapter.test.ts` (Idempotenz, `engine_error`-Gating)
- `apps/bridge/src/services/graphics/graphics-runtime-init-service.test.ts` (Laden vs. Anwenden)
- `apps/bridge/src/services/graphics/graphics-manager.test.ts` (`applyPersistedOutput`)
- `apps/bridge/src/services/graphics/graphics-output-adapter-factory.test.ts` (kein DeckLink-Fallback)
- `apps/bridge/src/server.test.ts` (kein Auto-Connect beim Start)
- `apps/bridge/src/services/relay-command-allowlist.test.ts`, `relay-command-policy.test.ts`

## Relevante Dateien
- `apps/bridge/src/services/mode/mode-activation-service.ts`
- `apps/bridge/src/services/mode/mode-activation-state.ts`
- `apps/bridge/src/services/command-router.ts`
- `apps/bridge/src/services/engine-adapter.ts`
- `apps/bridge/src/services/graphics/graphics-manager.ts`
- `apps/bridge/src/services/graphics/graphics-runtime-init-service.ts`
- `apps/bridge/src/services/graphics/graphics-output-adapter-factory.ts`
- `apps/bridge/src/server.ts`
- `packages/protocol/src/index.ts`
