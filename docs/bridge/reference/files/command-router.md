# File Reference – apps/bridge/src/services/command-router.ts

## Zweck
Zentrale Dispatch‑Logik für Commands (Relay + HTTP). Keine Self‑HTTP‑Calls, direkte Service‑Aufrufe.

## Ein-/Ausgänge
- Input: `RelayCommand`, optional `payload`
- Output: `{ success, data?, error?, errorCode? }`
- Canon‑XC‑Handler (`canon_xc_test_connection`, `canon_xc_test_device`, `canon_xc_list_presets`, `canon_xc_recall_preset`) laufen über `canon-xc/canon-xc-command-result.ts`: eine Service‑Antwort mit `ok:false` wird zu `success:false`, `error` = `rawError` (falls nichtleer) sonst `message`, `errorCode` = `diagnostic.code` sonst `canon_xc_failed`; `data` enthält weiterhin die vollständige Canon‑Antwort (`ok`, `message`, `rawError`, `diagnostic`, …). `canon_xc_list_devices`, `canon_xc_save_device` und `canon_xc_delete_device` liefern keine Canon‑Antwort dieses Typs und bleiben unverändert.

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
