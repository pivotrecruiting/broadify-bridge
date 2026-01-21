Graphics Renderer Findings (Ist-Stand)

Status (code-basiert)

1) Template Bindings vorhanden
- CSS Variablen, Text Content und Animation Klassen werden in
  `apps/bridge/src/services/graphics/template-bindings.ts` abgeleitet.
- Renderer wendet `cssVariables`, `textContent`, `textTypes` und
  `animationClass` an (`apps/bridge/src/services/graphics/renderer/electron-renderer-entry.ts`).

2) Frame Transport
- Frames gehen via TCP IPC (127.0.0.1) vom Renderer zum Bridge-Prozess.
- IPC ist per Token-Handshake abgesichert.

3) graphics_list
- `graphics_list` liefert `outputConfig` + `layers` (siehe
  `apps/bridge/src/services/graphics/graphics-manager.ts`).

Offene Punkte

- Bufferlaenge in `compositeLayers()` validieren.
- Premultiplied/straight Alpha explizit dokumentieren.
