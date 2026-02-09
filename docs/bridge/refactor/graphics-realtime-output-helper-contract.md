# Graphics Realtime Refactor – Output Helper Contract

## Zweck
Beschreibt, wie Output-Helper (DeckLink/Display) mit dem FrameBus arbeiten und wie Start/Stop gesteuert wird.

## SSOT Referenzen
- Output Adapter Interface: `apps/bridge/src/services/graphics/output-adapter.ts`
- DeckLink Adapter: `apps/bridge/src/services/graphics/output-adapters/decklink-video-output-adapter.ts`
- Display Adapter: `apps/bridge/src/services/graphics/output-adapters/display-output-adapter.ts`
- Output Config Schema: `apps/bridge/src/services/graphics/graphics-schemas.ts`

## Prozess-Start (Vorschlag)
Output-Helper werden wie bisher als Child-Process gestartet, erhalten aber zusätzliche Env-Parameter:
- `BRIDGE_FRAMEBUS_NAME`
- `BRIDGE_FRAMEBUS_SIZE`
- `BRIDGE_FRAME_WIDTH`
- `BRIDGE_FRAME_HEIGHT`
- `BRIDGE_FRAME_FPS`
- `BRIDGE_FRAME_PIXEL_FORMAT`

## Laufzeit-Verhalten
- Helper liest `readLatest()` pro Tick.
- Tick-Frequenz = `fps` aus Output-Config.
- Wenn kein neues Frame: letztes Frame wiederholen.

## Stop
- Bridge sendet Shutdown-Signal.
- Helper schließt FrameBus und beendet Prozess.

## Output-spezifisch
### DeckLink
- Frames werden in der Helper-Schicht in das benötigte Pixel-Format gebracht.
- Bei Key/Fill werden zwei Outputs synchronisiert.
- Pixel-Format-Prioritäten bleiben unverändert (SSOT: `output-format-policy.ts`).
- Hinweis: `key_fill_split_sdi` bleibt vorerst im Legacy-Pfad (stdin), bis ein nativer Split im Helper implementiert ist.

### Display
- GPU Rendering, optional Skalierung auf Monitor-Größe.
- Debug-Overlay optional.

## TODO
- [ ] Env-Parameter final festlegen.
- [ ] DeckLink Helper Konfiguration mit FrameBus kombinieren.
- [ ] Display Helper FrameBus Support definieren.
