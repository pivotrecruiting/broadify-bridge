# File Reference – apps/bridge/src/services/graphics/graphics-manager.ts

## Zweck
Orchestriert Graphics-Use-Cases (Configure, Send, Update, Remove, Preset, Status) und delegiert technische Details an spezialisierte Services.

## Ein-/Ausgänge
- Input: Graphics payloads (`graphics_*`)
- Output: Renderer-/Output-Kommandos, Bridge-Events (`graphics_status`, `graphics_error`)

## Abhängigkeiten
- Renderer: `renderer/*`
- Output‑Adapter: `output-adapters/*`
- Layer/Prepare: `graphics-layer-service.ts`, `graphics-layer-prepare-service.ts`
- Presets: `graphics-preset-service.ts`
- Output-Transition: `graphics-output-transition-service.ts`
- Runtime-Init: `graphics-runtime-init-service.ts`
- FrameBus-Session: `graphics-framebus-session-service.ts`
- Diagnostics/Events: `graphics-payload-diagnostics.ts`, `graphics-event-publisher.ts`
- Output‑Config: `output-config-store.ts`

## Side‑Effects
- Startet Renderer‑Prozess
- Persistiert Output‑Config
- Schaltet Output-Adapter atomar um (inkl. Rollback bei Fehlern)
- Setzt FrameBus-Umgebungsvariablen für Renderer/Helper-Pfade

## Fehlerfälle
- Outputs nicht konfiguriert
- Payload-/Template-Validierung fehlschlägt
- Helper/Renderer nicht verfügbar oder Output-Transition schlägt fehl
