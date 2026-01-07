# Production Logs (Tray App + Bridge)

This describes how logs are captured and how to view them in production.

## What Gets Logged

- **Bridge logs**: Fastify + bridge services, written to `bridge.log`.
- **App logs**: Electron main process events for outputs/IPC, written to `app.log`.

## Locations

- Bridge log: `<userData>/logs/bridge.log`
- App log: `<userData>/logs/app.log`

`<userData>` is the Electron userData folder (platform-specific).

## Viewing Logs in the Tray App

1. Open the Tray App UI.
2. Click the **Settings** icon (top-left).
3. Choose **Bridge Logs** or **App Logs**.
4. Use **Lines** + **Filter** then **Refresh**.
5. Use **Clear** to wipe the selected log file.

## HTTP Endpoint (Bridge)

The tray app reads bridge logs through:

```
GET /logs?lines=500&filter=Outputs
```

To clear bridge logs:

```
POST /logs/clear
```

Response shape:

```json
{
  "scope": "bridge",
  "lines": 123,
  "content": "...log lines..."
}
```

## Common Filters

- `Outputs` → device/output refresh flow
- `GraphicsOutput` → FFmpeg SDI/NDI output
- `Decklink` / `USB` → device detection

## Notes

- Log file rotates when `bridge.log` exceeds 5 MB.
- If the bridge is not reachable, the UI will show an error in the log dialog.
