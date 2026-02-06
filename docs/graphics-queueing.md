# Graphics Preset Send & Replace (Stand: 2026-02-02)

## Kurzfassung

- Kein Queueing: Es gibt maximal ein aktives Preset.
- Ein neues Preset ersetzt alle bestehenden Layer anderer Presets.
- Presets mit Count (`durationMs > 0`) werden nach Ablauf automatisch entfernt.
- Klick auf aktives Preset -> remove. Klick auf anderes Preset -> replace.

## Begriffe

- **Preset**: Kombination aus Templates und Layouts, optional mit Count (`durationMs`).
- **Kategorie**: `lower-thirds`, `overlays`, `slides` (max. ein Layer pro Kategorie).
- **Count/No-Count**: `durationMs > 0` bedeutet Count, nicht gesetzt bedeutet No-Count.
- **Active Preset**: Das aktuell on-air Preset inkl. Layern und optionalem Timer.

## Bridge-Verhalten

1. **graphics_send ohne presetId**
   - Normales Layer-Update ohne Preset-Status.
2. **graphics_send mit presetId**
   - Entfernt alle Layer, die nicht zu diesem Preset gehoeren.
   - Rendert die neuen Layer und markiert das Preset als aktiv.
   - Count startet beim ersten Output-Frame; nach `durationMs` wird das Preset entfernt.
3. **graphics_remove_preset(presetId)**
   - Entfernt alle Layer dieses Presets und loescht den Active-Status.

## Status

- `graphics_list` liefert `activePreset` und optional `activePresets` (max. 1 Eintrag).
- Keine `queuedPresets`.

## Code-Referenzen

- `graphics_send` Routing: `apps/bridge/src/services/command-router.ts`
- Preset Replace/Timer: `apps/bridge/src/services/graphics/graphics-manager.ts`
- Payload-Schema: `apps/bridge/src/services/graphics/graphics-schemas.ts`
