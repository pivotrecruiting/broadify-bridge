# File Reference – apps/bridge/src/services/graphics/graphics-framebus-session-service.ts

## Zweck
Zentrale FrameBus-Session-Policy für Graphics-Output-Transitions und Runtime-Init.

## Ein-/Ausgänge
- Input: `GraphicsOutputConfigT` + optional vorherige `FrameBusConfigT`
- Output: aufgelöste `FrameBusConfigT` und gesetzte FrameBus-Environment-Variablen

## Abhängigkeiten
- Bridge Context Logger: `../bridge-context.js`
- FrameBus Config Helpers: `framebus/framebus-config.ts`

## Side‑Effects
- Schreibt FrameBus-Umgebungsvariablen über `applyFrameBusEnv`
- Loggt relevante Config-Änderungen (Name, SlotCount, PixelFormat, Dimensionen, FPS)
- Warnt bei nicht unterstütztem Pixel-Format (erzwingt RGBA8)

## Fehlerfälle
- Ungültige/inkonsistente Output-Config führt zu Fehlern aus den FrameBus-Config-Helpern
