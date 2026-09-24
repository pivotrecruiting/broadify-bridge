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
- Playback ist Single-Path ueber FrameBus. stdin wird nur noch fuer den
  DeckLink-Shutdown-Header genutzt; es gibt keinen RGBA-Frame-Fallback ueber
  stdin.

## Handshake
- Helper sendet `{"type":"ready"}` erst nach erfolgreicher FrameBus-Validierung.
- `ready` darf additiv `helperVersion` enthalten. Die Bridge speichert die
  Version, verlangt sie aber nicht.
- Die Bridge begrenzt den Ready-Handshake: DeckLink 12s, Display 8s. Bei
  Timeout beendet sie den Helper und meldet den Fehler mit stderr-Kontext.
- Zukuenftige Helper duerfen `{"type":"playback_started"}` und
  `{"type":"fatal","code":"...","message":"..."}` senden. Aktuelle Helper,
  die nur `ready`/`metrics` senden, bleiben gueltig; unbekannte Events werden
  toleriert.

## Stop
- Bridge sendet Shutdown-Signal.
- Helper schließt FrameBus und beendet Prozess.
- Bridge wartet kurz auf Exit und sendet bei Bedarf `SIGTERM`/`SIGKILL`.
- Ein Exit nach `ready`, der nicht durch `stop()` angefordert wurde, wird als
  Lifecycle-Event an den GraphicsManager gemeldet und triggert
  Output-Supervisor-Recovery.

## Output-spezifisch
### DeckLink
- Frames werden in der Helper-Schicht in das benötigte Pixel-Format gebracht.
- Bei Key/Fill werden zwei Outputs synchronisiert.
- Pixel-Format-Prioritäten bleiben unverändert (SSOT: `output-format-policy.ts`).
- Eingangsformat aus Renderer/FrameBus ist immer RGBA8.
- Key/Fill-Output ist ARGB8-only. BGRA ist nicht erlaubt; bei fehlender ARGB-Unterstützung muss die Konfiguration fehlschlagen.

### Display
- GPU Rendering, optional Skalierung auf Monitor-Größe.
- Debug-Overlay optional.
- **Native Display Helper** (optional): Bei `BRIDGE_DISPLAY_NATIVE_HELPER=1` wird ein C++/SDL2-Prozess statt des Electron-Helpers gestartet. Liest FrameBus direkt, rendert per SDL/OpenGL fullscreen. Kein IPC für Frames. Pfad-Auflösung: `resolveDisplayHelperPath()` in `apps/bridge/src/modules/display/display-helper.ts`.

## Status (Stand heute)
- DeckLink Helper kann FrameBus lesen.
- Display Helper kann FrameBus lesen (Electron oder Native).
- Env-Parameter sind auf Bridge-Seite gesetzt (Name/Size/Format/FPS).
