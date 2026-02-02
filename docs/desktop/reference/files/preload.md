# File Reference – src/electron/preload.cts

## Zweck
Expose der whitelisted IPC‑API für den Renderer.

## Ein-/Ausgänge
- Input: Renderer‑Calls über `window.electron.*`
- Output: IPC invoke results + event subscriptions

## Abhängigkeiten
- `src/electron/types.ts`

## Security
- Kein Node‑Zugriff im Renderer; nur whitelisted API.
