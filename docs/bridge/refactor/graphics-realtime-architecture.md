# Graphics Realtime Refactor – Architektur

## Leitprinzip
Trennung von Control-Plane und Data-Plane. Die Bridge steuert, die Frame-Daten laufen außerhalb der Bridge über Shared Memory direkt zum Output-Helper.

## Komponenten und Verantwortung
### Bridge (Control-Plane)
- Validierung von Commands und Payloads.
- Preset-Lifecycle und Status-Publishing.
- Renderer-Commands (`create_layer`, `update_values`, `update_layout`).
- Keine Frames, kein Compositing, kein FPS-Ticker.

### Renderer (Electron)
- Ein einzelnes Render-Window pro Session.
- Layer-Komposition im DOM.
- Offscreen Rendering und Frame-Write in FrameBus.

### FrameBus (Shared Memory)
- Lock-free, latest-frame-wins.
- Keine TCP-IPC für Frames.
- Reader ist der aktive Output-Helper.

### Output-Helper
- DeckLink Helper liest Frames aus FrameBus und tickt im Ziel-FPS.
- Display Helper liest Frames aus FrameBus und rendert per GPU.

## Architektur-Entscheidungen
- Single Output pro Session.
- Frame-Transport über Shared Memory.
- CSS-Isolation über Shadow DOM je Layer (Best Practice, echte Isolation).

## Abgeleitete Prinzipien
- Renderer ist die einzige Instanz, die Layer-HTML/CSS versteht.
- Bridge sendet nur strukturierte Commands und keine Frames.
- Output-Helper sind reine Frame-Consumer ohne Template-Wissen.

## TODO
- [ ] Interface-Änderungen für Renderer-Client definieren.
- [ ] FrameBus API finalisieren.
