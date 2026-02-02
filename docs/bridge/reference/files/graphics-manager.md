# File Reference – apps/bridge/src/services/graphics/graphics-manager.ts

## Zweck
Orchestriert Layer, Presets, Rendering und Output‑Streaming.

## Ein-/Ausgänge
- Input: Graphics payloads (`graphics_*`)
- Output: RGBA Frames an Output‑Adapter

## Abhängigkeiten
- Renderer: `renderer/*`
- Output‑Adapter: `output-adapters/*`
- Templates: `template-sanitizer.ts`, `template-bindings.ts`
- Assets: `asset-registry.ts`
- Output‑Config: `output-config-store.ts`

## Side‑Effects
- Startet Renderer‑Prozess
- Startet Ticker für Frame‑Output
- Persistiert Output‑Config

## Fehlerfälle
- Outputs nicht konfiguriert
- Template‑Validation errors
- Helper/Renderer nicht verfügbar
