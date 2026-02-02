# Bridge Graphics Queueing (Stand: 2026-02-02)

## Zweck
Diese Datei beschreibt das aktuelle Queueing- und Replace-Verhalten der Bridge fuer `graphics_send`, inklusive Active/Queue Status, Timer-Handling und Remove-Logik.

## Begriffe
- **Preset**: Zusammengehoerige Layer, identifiziert ueber `presetId`.
- **Kategorie**: `lower-thirds`, `overlays`, `slides`. Pro Kategorie ist nur ein aktiver Layer erlaubt.
- **Count-Preset**: `durationMs > 0`.
- **No-Count-Preset**: `durationMs === null`.
- **Active Presets**: Mehrere Presets koennen parallel aktiv sein, solange ihre Kategorien nicht kollidieren.
- **Queue**: Warteschlange fuer Presets, die wegen Konflikten nicht sofort aktiviert werden duerfen.
- **presetSendId**: Kennzeichnet einen Preset-Send ueber mehrere Kategorien, damit Queue-Eintraege zusammengefuehrt werden.

## Eingangspayload (Schema)
`graphics_send` akzeptiert zusaetzlich zu den bekannten Feldern:
- `presetSendId` (optional)
- `presetCategories` (optional, non-empty)

Wichtig: `durationMs` ist nur erlaubt, wenn `presetId` gesetzt ist.

Code:
- `/Users/dennisschaible/Desktop/Coding/broadify-bridge-v2/apps/bridge/src/services/graphics/graphics-schemas.ts:136`

## Userflow (Bridge-intern)
1. **Command Router** leitet `graphics_send` an `GraphicsManager.sendLayer` weiter.  
   Code: `/Users/dennisschaible/Desktop/Coding/broadify-bridge-v2/apps/bridge/src/services/command-router.ts:395`
2. **Payload-Validierung** via Zod.
3. **Decision** (Queue vs Send):
   - Kategorien werden aus `presetCategories` oder aus `category` abgeleitet.
   - Konflikte pro Kategorie werden bestimmt.
   - Count-Preset:
     - Konflikt vorhanden -> Queue.
     - Kein Konflikt -> Send.
   - No-Count-Preset:
     - Konflikt mit Count-Preset -> Queue.
     - Konflikt nur mit No-Count-Preset -> Send + konfliktierende Presets werden komplett entfernt.
4. **Render**:
   - Kategorie-Konflikte werden entfernt.
   - Layer werden gerendert und dem Preset zugeordnet.
5. **Active Presets**:
   - Preset wird zu `activePresets` hinzugefuegt oder erweitert.
6. **Timer**:
   - Start bei erstem Frame (`pendingStart`), Ablauf fuehrt zu Preset-Entfernung und Queue-Aktivierung.

Code:
- Entscheidungslogik: `/Users/dennisschaible/Desktop/Coding/broadify-bridge-v2/apps/bridge/src/services/graphics/graphics-manager.ts:326`
- Timer/Expiration: `/Users/dennisschaible/Desktop/Coding/broadify-bridge-v2/apps/bridge/src/services/graphics/graphics-manager.ts:1149`

## Queue-Logik
- Queue-Eintrag wird per `presetSendId` ueber die gesamte Queue coalesced.
- Ohne `presetSendId` wird nur der Queue-Tail mit gleicher `presetId` zusammengefuehrt.
- Maximal `MAX_QUEUED_PRESETS`.

Code:
- Queue-Coalescing: `/Users/dennisschaible/Desktop/Coding/broadify-bridge-v2/apps/bridge/src/services/graphics/graphics-manager.ts:1100`

## Aktivierung der Queue
- `canActivateQueuedPreset` blockt, wenn Konflikte mit aktiven Kategorien bestehen.
- Vor Aktivierung werden konfliktierende No-Count-Presets entfernt.
- Danach werden alle Layer gerendert und das Preset aktiv gesetzt.

Code:
- Aktivierung: `/Users/dennisschaible/Desktop/Coding/broadify-bridge-v2/apps/bridge/src/services/graphics/graphics-manager.ts:1243`
- Konfliktregeln: `/Users/dennisschaible/Desktop/Coding/broadify-bridge-v2/apps/bridge/src/services/graphics/graphics-manager.ts:1290`
- Konfliktpruefung/Activation Gate: `/Users/dennisschaible/Desktop/Coding/broadify-bridge-v2/apps/bridge/src/services/graphics/graphics-manager.ts:1403`

## Entfernen von Presets
- `graphics_remove_preset` entfernt das Preset und:
  - `clearQueue=true` -> gesamte Queue wird geloescht.
  - `clearQueue=false` -> nur Queue-Eintraege dieses Presets werden entfernt.

Code:
- `/Users/dennisschaible/Desktop/Coding/broadify-bridge-v2/apps/bridge/src/services/graphics/graphics-manager.ts:528`

## Statusausgabe
`graphics_list` liefert:
- `activePreset` (Legacy, letzter aktivierter Eintrag)
- `activePresets` (vollstaendige Liste)
- `queuedPresets`

Code:
- `/Users/dennisschaible/Desktop/Coding/broadify-bridge-v2/apps/bridge/src/services/graphics/graphics-manager.ts:573`
