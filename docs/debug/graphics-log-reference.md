# Graphics Log Reference (Debug)

Dieses Dokument beschreibt alle eingebauten Debug‑Logs in der Graphics‑Pipeline
und die erwarteten Soll‑Werte für das Testbild.

## Testbild (Sollwerte)

Testbild (roter Hintergrund, schwarzer Kreis in der Mitte):
- Ecke (0,0): RGBA ≈ **[255,0,0,255]**
- Mitte (center): RGBA ≈ **[0,0,0,255]**
- Ecke (bottomRight): RGBA ≈ **[255,0,0,255]**

Hinweis: Kleine Abweichungen sind ok (z. B. 254 statt 255) durch Rundung.

## Logs (Reihenfolge)

### 1) Renderer DOM State

**Log:**
`[GraphicsRenderer] Debug DOM state`

**Soll:**
- `containerRect.width/height` > 0
- `rootRect.width/height` > 0
- `elementRect.width/height` > 0
- `hasElement: true`
- `hasContent: true`
- `elementStyle.display !== "none"`
- `elementStyle.visibility !== "hidden"`
- `elementStyle.opacity` ≈ `"1"`
- `layout.scale` > 0

Zusatzlog:
`[GraphicsRenderer] Debug DOM state (delayed)`  
Soll identisch oder stabil (nach Animations‑Delay).

---

### 2) Renderer Pixel Samples

**Log:**
`[GraphicsRenderer] Debug pixel samples`

**Soll (Testbild):**
- `topLeft` ≈ `[255,0,0,255]`
- `center` ≈ `[0,0,0,255]`
- `bottomRight` ≈ `[255,0,0,255]`

Wenn hier alles `[0,0,0,0]` ist: Renderer liefert leere Frames
(DOM unsichtbar oder 0×0).

---

### 3) Composite / Output Samples

**Log:**
`[Graphics] Debug output pixel samples`

**Soll:**
Gleiche Werte wie im Renderer (Testbild).

Wenn Renderer korrekt, aber hier 0:
Composite/Layer‑Handling überprüfen (z. B. fehlende `lastFrame`).

---

### 4) Adapter Samples (Bridge → Helper)

**Log:**
`[DeckLinkOutput] Debug pixel samples`

**Soll:**
Gleiche Werte wie im Renderer (Testbild).

Wenn hier 0, aber Composite ok:
Übergabe im Adapter prüfen.

---

### 5) Helper Input Samples (Native)

**Log:**
`[DeckLinkOutput] [DeckLinkHelper] Input RGBA samples (rowBytes=...)`

**Soll:**
Gleiche Werte wie im Renderer (Testbild).

Wenn hier 0, aber Adapter ok:
IPC/StdIn‑Pfad prüfen.

---

### 6) Helper Output Samples (Native)

**Log:**
`[DeckLinkHelper] Output samples (...)`

**Soll (bei 8bit_argb):**
- Byte0 = Alpha
- Byte1 = Red
- Byte2 = Green
- Byte3 = Blue

**Soll (bei 8bit_bgra):**
- Byte0 = Blue
- Byte1 = Green
- Byte2 = Red
- Byte3 = Alpha

Hinweis: Der Log ist nur vorhanden, wenn der Helper erfolgreich
ein Frame in die Ziel‑Buffer geschrieben hat.

---

## Fehlerbilder (Kurzdiagnose)

- **Alle Logs zeigen `[0,0,0,0]`**  
  → DOM/Renderer liefert leere Frames (Layout/CSS/Content).

- **Renderer ok, Composite 0**  
  → Layer/Composite‑Handling (z. B. fehlende `lastFrame`).

- **Composite ok, Adapter 0**  
  → Übergabe im Adapter.

- **Adapter ok, Helper Input 0**  
  → IPC/StdIn‑Pfad oder Helper‑Binary.

- **Helper Output falsch (ARGB/BGRA)**  
  → Byte‑Order/Pixel‑Format‑Handling im Helper.

