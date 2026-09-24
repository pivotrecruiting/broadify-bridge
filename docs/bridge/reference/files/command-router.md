# File Reference – apps/bridge/src/services/command-router.ts

## Zweck
Zentrale Dispatch‑Logik für Commands (Relay + HTTP). Keine Self‑HTTP‑Calls, direkte Service‑Aufrufe.

## Ein-/Ausgänge
- Input: `RelayCommand`, optional `payload`
- Output: `{ success, data?, error?, errorCode? }`

## Abhängigkeiten
- `engine-adapter.ts`
- `device-cache.ts`
- `runtime-config.ts`
- `graphics-manager.ts`
- `relay-command-schemas.ts`

## Side‑Effects
- Ruft Engine‑Connect/Macro‑Actions auf
- Startet/konfiguriert Graphics‑Pipeline
- Persistiert Engine‑Verbindungen nicht selbst; erfolgreiche Connects werden im `EngineAdapterService` gespeichert, damit Relay und HTTP denselben Pfad nutzen.

## Fehlerfälle
- Missing payload
- Zod‑Validation in `GraphicsManager` (graphics)
- Zod‑Validation in `CommandRouter` (non-graphics)
- Fehler mit nichtleerem `code`-Feld (z. B. `EngineError`, `GraphicsError`, Node‑Systemfehler) werden als `errorCode` im Command‑Ergebnis weitergegeben.
