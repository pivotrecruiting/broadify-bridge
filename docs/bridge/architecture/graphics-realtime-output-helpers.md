# Graphics Realtime Refactor – Output Helpers

## DeckLink Helper
- Liest Frames aus dem FrameBus.
- Tickt mit Ziel-FPS aus `graphics_configure_outputs`.
- Wiederholt letztes Frame, wenn kein neues vorhanden ist.
- Eingangsformat ist immer RGBA8 (Renderer/FrameBus).
- Key/Fill-Output ist ARGB8-only. BGRA ist nicht erlaubt; bei fehlender ARGB-Unterstützung muss die Konfiguration fehlschlagen.
- Legacy-stdin-Frames bleiben als Notfallpfad.

## Display Helper
- Liest Frames aus dem FrameBus.
- Rendert per GPU (WebGL im Electron-Helper, spätere native GPU-Pfade möglich).
- Skalierung auf Ziel-Display falls nötig.
- Legacy-stdin-Frames bleiben als Notfallpfad.

## Helper-Lifecycle: stdin-Fehler werden toleriert
- Die Bridge schreibt Shutdown-Header bzw. Kommandos über die stdin-Pipe des Helpers (`HelperProcessSession`, ATEM-USB-Adapter).
- Ein Helper, der seine Pipe bereits geschlossen hat, erzeugt auf dem stdin-Stream ein asynchrones `error`-Event (`EPIPE`, `ERR_STREAM_DESTROYED`, `ERR_STREAM_WRITE_AFTER_END`). Ohne Listener wäre das eine `uncaughtException` und damit ein Bridge-Neustart.
- Deshalb hängt `apps/bridge/src/services/shared/child-process-stdin.ts` direkt nach `spawn` einen idempotenten `error`-Handler an (`attachChildStdinErrorHandler`): die genannten Codes werden auf `debug` geloggt (Helper ist schon weg), alles andere auf `warn`. Schreibzugriffe laufen über `writeChildStdin`, das bei nicht beschreibbarem stdin `false` liefert statt zu werfen; der Stop-Pfad eskaliert dann wie gewohnt über SIGTERM/SIGKILL.

## Status (Stand heute)
- FrameBus-Reader in DeckLink Helper implementiert.
- FrameBus-Reader in Display Helper implementiert.
- Pixel-Format-Entscheidung: RGBA8 input, ARGB8-only für Key/Fill, kein BGRA-Fallback.
