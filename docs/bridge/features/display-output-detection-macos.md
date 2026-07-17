# Bridge Feature – macOS Display Output Detection

## Zweck
Diese Doku beschreibt, wie der Bridge auf macOS externe Displays erkennt und als Output-Ports bereitstellt.
Fokus: Erkennung (Detection), Normalisierung und Mapping in das Device/Port‑Modell.

## Geltungsbereich
- Nur macOS (`darwin`)
- Externe Displays (Built‑in Displays werden herausgefiltert)
- Reine Erkennung: keine Garantie über verfügbare Modes außerhalb des aktuell aktiven Modus

## Datenquelle
Die Detection basiert auf `system_profiler`:

```
system_profiler SPDisplaysDataType -json
```

Warum:
- Stable, system‑provided, keine externen SDKs erforderlich
- Liefert strukturierte Infos zu Displays und Ports

## Ablauf (Kurz)
1. `DisplayModule.detect()` ruft `system_profiler` mit Hard‑Timeout (5s) auf; der
   umgebende Modul-Timeout beträgt 6s.
2. JSON wird geparst, rekursiv nach `spdisplays_ndrvs` gesucht.
3. Built‑in Displays werden gefiltert.
4. Relevante Felder werden über Key‑Listen extrahiert.
5. Ergebnis wird in `DeviceDescriptorT` + `PortDescriptorT` normalisiert.

## Feld‑Mapping

### Display → DeviceDescriptorT
- `id`: aus `vendorId`, `productId`, `serial` (sanitized, stabil)
  - Fallback: `display-<name>-<index>`
  - Kollisionen werden mit Suffix aufgelöst
- `displayName`: aus `_name`/`spdisplays_display_name`
- `type`: `"display"`
- `vendor`: `spdisplays_display_vendor-id` / `spdisplays_display_vendor_id`
- `model`: `spdisplays_display_product-id` / `spdisplays_display_product_id`
- `status`: `present/ready/inUse/signal/lastSeen` (aktuell konservativ)

### Display → PortDescriptorT
- `type`: normalisiert aus `spdisplays_connection_type` u.a.
  - Mappings: `hdmi`, `displayport`, `thunderbolt`
  - Fallback bei fehlendem Typ: `displayport` (mit Warn‑Log)
- `direction`: `"output"`
- `role`: `"video"`
- `displayName`: `"HDMI Output"` / `"DisplayPort Output"` / `"Thunderbolt Output"`
- `capabilities.modes`: nur aktueller Modus, wenn Auflösung + Refresh vorhanden
- `capabilities.formats`: abgeleitet aus dem Mode‑Label (z. B. `1080p60`)

## Modus‑Ermittlung
`OutputDisplayModeT` wird aus dem aktiven Display‑Mode gebaut:
- `resolution`: Parsing von `"3840 x 2160"` o.ä.
- `refreshHz`: Parsing von `"59.94 Hz"` o.ä.
- Label: `"<height>p<fps> (<width>x<height>)"`

Wenn Auflösung oder Refresh fehlen:
- `modes` bleibt leer
- `formats` bleibt leer

## Integration ins Output‑Modell
Die Geräte erscheinen in `/outputs` als `type: "display"`.
UI‑Logik kann damit externe Displays getrennt von DeckLink und Capture anzeigen.

## Limitierungen
- `system_profiler` kann je nach System langsam sein → Hard‑Timeout
- Einige GPUs liefern keine eindeutigen Connection‑Typen → Fallback + Warnung
- Nur aktuell aktiver Modus wird erkannt, keine vollständige Mode‑Liste

## Fehler- und Cache-Semantik

- Spawn-Fehler, Nonzero-Exit, Timeout und ungültiges JSON sind fehlgeschlagene
  Erkennungen. Der Kindprozess wird bei Timeout mit `SIGTERM` beendet.
- Diese Fehler werden nicht als erfolgreicher Leerfund veröffentlicht. Der
  per-Modul geführte `DeviceCache` behält dadurch den letzten gültigen Display-Stand.
- Ein syntaktisch und strukturell valides `SPDisplaysDataType` ohne externe Displays
  bleibt ein erfolgreicher Leerfund und entfernt ein tatsächlich getrenntes Display
  aus dem Cache.
- `/outputs?refresh=1` und `list_outputs` mit `refresh: true` starten jeweils eine neue
  Discovery; automatisches macOS-Hotplug ist davon unabhängig und nicht garantiert.
- `list_outputs` ohne `refresh: true` liest ausschließlich den vorhandenen Bridge-Cache.
  Ein WebApp-Reload startet deshalb keine neue Display-Discovery.

## Security Notes
- Der Prozess nutzt einen fest verdrahteten lokalen Befehl ohne User‑Input.
- Laufzeit ist begrenzt (Timeout) und JSON wird defensiv geparst.
- Keine Netzwerkzugriffe während der Detection.

## Troubleshooting
- Display fehlt:
  - Prüfe `system_profiler SPDisplaysDataType -json` manuell
  - Built‑in Display wird bewusst gefiltert
- Falscher Port‑Typ:
  - Siehe Logs: `[DisplayDetector] Missing connection type ...`
- Keine Modes:
  - Prüfe, ob `resolution`/`refresh` im `system_profiler` Output vorhanden ist
- Display‑Helper zeigt nur Schwarz / kein Frame:
  - Prüfe, ob der Preload geladen wird (Overlay zeigt **nicht** `Missing preload API`).
  - Ursache kann ein ESM‑Preload sein. Electron‑Preload muss **CommonJS** sein.
  - Lösung: Preload als CJS bauen (z. B. `display-output-preload.cts` → `display-output-preload.cjs`) und im Adapter bevorzugen.
  - Nach Änderungen `npm --prefix apps/bridge run build:graphics-renderer` ausführen und Bridge neu starten.
- Erstes Bild kommt verzögert:
  - Der Helper kann einige Sekunden bis zum ersten Frame brauchen.
  - Optionales Debug‑Overlay aktivieren: `BRIDGE_DISPLAY_DEBUG=1`.
  - In `development` wird das Overlay automatisch aktiviert (wenn nicht explizit gesetzt).
  - Deaktivieren: `BRIDGE_DISPLAY_DEBUG=0`.
  - Overlay‑Infos: Canvas‑Größe, Frame‑Größe, Frame‑Counter, Preload‑Status (`Missing preload API`).

## Relevante Dateien
- `apps/bridge/src/modules/display/display-module.ts`
- `apps/bridge/src/modules/index.ts`
- `apps/bridge/src/routes/outputs.ts`
- `packages/protocol/src/index.ts`
- `apps/bridge/src/services/graphics/output-adapters/display-output-adapter.ts`
- `apps/bridge/src/services/graphics/display/display-output-entry.ts`
- `apps/bridge/src/services/graphics/display/display-output-preload.cts`
