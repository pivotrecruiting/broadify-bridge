# Graphics Realtime Refactor – Output Helpers

## DeckLink Helper
- Liest Frames aus dem FrameBus.
- Tickt mit Ziel-FPS aus `graphics_configure_outputs`.
- Wiederholt letztes Frame, wenn kein neues vorhanden ist.

## Display Helper
- Liest Frames aus dem FrameBus.
- Rendert per GPU (Metal/D3D/OpenGL).
- Skalierung auf Ziel-Display falls nötig.

## TODO
- [ ] FrameBus-Reader in DeckLink Helper implementieren.
- [ ] FrameBus-Reader in Display Helper implementieren.
- [ ] Pixel-Format-Support BGRA/RGBA klären.
