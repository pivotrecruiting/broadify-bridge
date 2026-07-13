# Bridge Subsystem – Device Discovery

## Zweck
Dieses Subsystem erkennt verfügbare Geräte (DeckLink, Display, USB Capture), cached Ergebnisse und stellt sie der UI als Output‑Liste zur Verfügung.

## Verantwortlichkeiten
- Registrierung von Device‑Modulen
- Parallelisierte Device‑Detection mit Timeout/Isolation
- Cache + Rate‑Limit für Refresh
- Watcher für Hotplug‑Events
- Mapping von Device/Port‑Model zu UI‑Outputs

## Hauptkomponenten
- `apps/bridge/src/modules/index.ts`
- `apps/bridge/src/modules/module-registry.ts`
- `apps/bridge/src/services/device-cache.ts`
- `apps/bridge/src/modules/decklink/*`
- `apps/bridge/src/modules/display/*`
- `apps/bridge/src/modules/usb-capture/*`
- `apps/bridge/src/routes/outputs.ts`

## Ablauf (Mermaid)
```mermaid
sequenceDiagram
  participant UI as Client/UI
  participant Outputs as /outputs route
  participant Cache as DeviceCache
  participant Registry as ModuleRegistry
  participant Decklink as DecklinkModule
  participant Display as DisplayModule
  participant DeckHelper as DeckLink Helper
  participant DisplayHelper as Display Helper

  UI->>Outputs: GET /outputs
  Outputs->>Cache: getDevices(forceRefresh?)
  Cache->>Registry: detectModules([display, decklink])
  Registry->>Decklink: detect()
  Registry->>Display: detect()
  Decklink->>DeckHelper: list devices + modes
  Display->>DisplayHelper: Windows: native topology + DXGI modes
  Decklink-->>Registry: DeckLink devices
  Display-->>Registry: Display devices
  Registry-->>Cache: combined devices
  Cache-->>Outputs: devices
  Outputs-->>UI: outputs {output1, output2}
```

## Cache & Refresh
- Cache TTL: 1s
- Force‑Refresh: rate‑limited (2s)
- Watcher: debounced refresh (250ms)
- Cache wird pro Modul geführt. Timeout/Fehler behalten den letzten erfolgreichen
  Modulstand; ein erfolgreicher leerer Scan entfernt abgezogene Geräte.
- Output-Abfragen erkennen nur `display` und `decklink`. USB-Capture kann dadurch
  weder `/outputs` noch Graphics-Konfiguration blockieren.

## Security & Risiken
- **Native Helper:** DeckLink‑Helper wird per Child‑Process ausgeführt.
- **Platform Abhängigkeit:** DeckLink nur macOS, Display-Module auf macOS/Windows.
- **Untrusted Data:** Helper‑Output wird per Zod geparst und validiert.

## Relevante Dateien
- `apps/bridge/src/services/device-cache.ts`
- `apps/bridge/src/modules/module-registry.ts`
- `apps/bridge/src/modules/decklink/decklink-detector.ts`
- `apps/bridge/src/modules/decklink/decklink-helper.ts`
- `apps/bridge/src/modules/display/display-module.ts`
- `apps/bridge/src/modules/display/display-helper.ts`
- `apps/bridge/src/modules/usb-capture/usb-capture-detector.ts`
- `apps/bridge/src/routes/outputs.ts`
