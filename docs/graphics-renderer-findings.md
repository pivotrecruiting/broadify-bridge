Graphics Renderer Findings

Indizien / Probleme

1. graphics_list return = {}
2. keine Layer werden erstellt und gesendet

- Contract‑Mismatch zwischen WebApp‑Templates und Bridge‑Renderer: - WebApp nutzt data-bid + CSS‑Variablen + renderTemplateHtml Logik (broadify/lib/template-builder/domain/render.ts). - Bridge‑Renderer ersetzt nur {{key}} und setzt keine CSS‑Variablen (apps/bridge/src/services/graphics/renderer/electron-renderer-entry.ts). - Ergebnis: CSS‑Variablen bleiben leer → Styles/Größen/Farben werden nicht angewandt → visuell quasi leer/transparent.
  - Das erklärt, warum Frames existieren (First Paint + Frame Tick), aber du “nichts siehst”.

####

Geplante Anpassungen (Bridge)

1. Port der WebApp‑Logik:
   - deriveCssVariables, deriveTextContent, deriveAnimationValue
   - getAnimationClassFromValue, getStandardAnimationCss
     Quelle:
   - /Users/dennisschaible/Desktop/Coding/broadify/lib/template-builder/domain/derive.ts
   - /Users/dennisschaible/Desktop/Coding/broadify/lib/template-builder/helpers.ts
2. Renderer‑Script in
   /Users/dennisschaible/Desktop/Coding/broadify-bridge-v2/apps/bridge/src/services/graphics/renderer/electron-renderer-entry.ts
   so umbauen, dass:
   - CSS‑Variablen gesetzt werden
   - data-bid Text ersetzt wird (inkl. list‑content)
   - Animation‑Klasse auf data-root="graphic" gesetzt wird
3. graphics_manager so erweitern, dass bei graphics_send/graphics_update_values die abgeleiteten Werte erzeugt und an den Renderer geschickt werden.
4. Hintergrund final anwenden, wenn Output kein Alpha unterstützt.
5. Graphic renderer logs in bridge-logs hinzufügen (aktuell nicht lle vorhanden)
6. bei bridge server stop alle bridge logs resetten
