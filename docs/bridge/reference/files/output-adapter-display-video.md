# File Reference – display-output-adapter.ts

## Zweck
Output-Adapter fuer externe Displays (HDMI/DisplayPort/Thunderbolt) ueber den nativen `display-helper` und FrameBus.

## Ein-/Ausgaenge
- Input: `GraphicsOutputConfigT` (insb. `video_hdmi` auf Display-Port)
- Output: gestarteter Display-Helper mit FrameBus-Session

## Abhaengigkeiten
- `apps/bridge/src/modules/display/display-helper.ts`
- `apps/bridge/src/services/graphics/framebus/framebus-config.ts`

## Side-Effects
- Spawnt `display-helper` (plattformabhaengig macOS/Windows)
- Setzt/liest FrameBus-Parameter fuer die Session
