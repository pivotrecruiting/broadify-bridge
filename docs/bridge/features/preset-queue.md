# Bridge Feature – Preset Lifecycle (ohne Queue)

## Zweck
Diese Doku beschreibt, wie Presets in der Graphics-Pipeline verwaltet werden
(Send, Replace, Remove, Count).

## Einstiegspunkte
- Orchestrierung: `apps/bridge/src/services/graphics/graphics-manager.ts`
- Schemas: `apps/bridge/src/services/graphics/graphics-schemas.ts`

## Begriffe
- **Preset**: Gruppierung mehrerer Layer unter einer `presetId`.
- **Active Preset**: Aktuelles Preset, dessen Layer aktiv gerendert werden.
- **Count**: Preset mit `durationMs > 0`, das nach Ablauf automatisch entfernt wird.

## Regeln & Verhalten
### Send / Replace
- `graphics_send` mit `presetId` aktiviert das Preset.
- Alle Layer anderer Presets werden entfernt (Replace).
- Es gibt maximal ein aktives Preset.

### Timer & Ablauf
- Preset-Timer startet beim ersten Frame-Output.
- `durationMs` steuert das Ablauf-Event.
- Nach Ablauf werden alle Layer des Presets entfernt.

### Entfernen
- `graphics_remove` entfernt einen Layer.
- `graphics_remove_preset` entfernt alle Layer eines Presets.

## Edge-Cases
- `durationMs` ohne `presetId` -> Validation Error.
- Ein neues Preset ersetzt das bisher aktive Preset.

## Relevante Dateien
- `apps/bridge/src/services/graphics/graphics-manager.ts`
- `apps/bridge/src/services/graphics/graphics-schemas.ts`
