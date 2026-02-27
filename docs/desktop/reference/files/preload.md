# File Reference – src/electron/preload.cts

## Zweck
Expose der whitelisted IPC‑API (`window.electron`) fuer den Renderer.

## Ein-/Ausgänge
- Input: Renderer‑Calls über `window.electron.*`
- Output: IPC invoke results + event subscriptions (`bridgeStatus`, `updaterStatus`)

## Abhängigkeiten
- `src/electron/types.ts`

## Security
- Kein Node‑Zugriff im Renderer; nur whitelisted API.
- Keine direkten Electron-Imports im UI-Code ausserhalb Preload.
