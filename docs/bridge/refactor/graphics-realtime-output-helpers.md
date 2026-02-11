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

## Status (Stand heute)
- FrameBus-Reader in DeckLink Helper implementiert.
- FrameBus-Reader in Display Helper implementiert.
- Pixel-Format-Entscheidung: RGBA8 input, ARGB8-only für Key/Fill, kein BGRA-Fallback.
