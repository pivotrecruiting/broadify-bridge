# Meeting Screen Sharing

Shares a local display or window into the Meeting program media layer. The
helper owns capture; the bridge only exposes relay contracts, status typing and
forced status publishes.

## Architecture

- Data plane: the native meeting helper captures a screen source and feeds it
  into the single Meeting renderer path. The program summary reports
  `media_layer.source: "screen"` while screen sharing is active.
- macOS backend: ScreenCaptureKit on macOS 14+ with the system picker
  (implemented in PR2/PR3). The picker path does not require the legacy Screen
  Recording TCC prompt.
- Windows backend: Windows Graphics Capture on Windows 10 1903+ (implemented
  in PR2/PR3). Cursor inclusion depends on Windows 10 2004+.
- Control plane: helper JSON-RPC methods `screen.list`, `screen.start`,
  `screen.stop` and `screen.pick`, forwarded by
  `apps/bridge/src/services/meeting/meeting-helper-client.ts`.

## Relay Commands

Allowlisted in `relay-command-allowlist.ts`, policies in
`relay-command-policy.ts`, handled in `meeting-command-handler.ts`:

| Command | Kind | Payload | Result data |
| --- | --- | --- | --- |
| `meeting_screen_list` | read only | none | `{ sources, capabilities }` |
| `meeting_screen_start` | side effect | `{ source_id, include_cursor? }` | `{ ok, source_id, kind, width, height, reopened }` |
| `meeting_screen_stop` | side effect | none | `{ ok: true }` |
| `meeting_screen_pick` | side effect | `{ include_cursor? }` | `{ ok: true, picker_pending: true }` |

`meeting_screen_pick` returns immediately. The user can spend minutes in the OS
picker, and completion is observed through `engine.screen_capture.running`.
Its relay replay policy is `never` so a retry cannot open a second system
dialog.

## Helper RPCs And Errors

RPC methods:

- `screen.list` -> `{ sources, capabilities }`
- `screen.start` -> `{ ok, source_id, kind, width, height, reopened }`
- `screen.stop` -> `{ ok: true }`
- `screen.pick` -> `{ ok: true, picker_pending: true }`

Helper error codes are surfaced unchanged as command `errorCode`:

- `screen_capture_unsupported`
- `screen_discovery_failed`
- `screen_source_not_found`
- `screen_start_failed`
- `screen_picker_failed`
- `screen_picker_busy`

## Status

`state.get` rides along inside `MeetingStatusT.engine`. Newer helpers expose:

Example (macOS, after a system-picker selection; the picker does not expose a
source id or window title, so both stay `null`):

```jsonc
{
  "screen_capture": {
    "running": true,
    "picker_pending": false,
    "source_id": null,
    "kind": "display",
    "title": null,
    "app_name": null,
    "width": 1920,
    "height": 1080,
    "captured_frames": 123,
    "last_error": null,
    "last_error_at": null,
    "capabilities": {
      "supported": true,
      "system_picker": true,
      "enumeration": false,
      "permission_status": "not_required",
      "unsupported_reason": null
    }
  },
  "program": {
    "media_layer": {
      "source": "screen"
    }
  }
}
```

Example (Windows, after `meeting_screen_start` with an enumerated id):

```jsonc
{
  "screen_capture": {
    "running": true,
    "picker_pending": false,
    "source_id": "monitor:0x10001",
    "kind": "display",
    "title": "\\\\.\\DISPLAY1 (DELL U2723QE)",
    "app_name": null,
    "width": 1920,
    "height": 1080,
    "captured_frames": 123,
    "last_error": null,
    "last_error_at": null,
    "capabilities": {
      "supported": true,
      "system_picker": false,
      "enumeration": true,
      "permission_status": "not_required",
      "unsupported_reason": null
    }
  }
}
```

`permission_status` is `not_required` on both supported platforms in this
stage and `unsupported` (with `unsupported_reason` `unsupported_os` or
`wgc_unavailable`) otherwise; `authorized`, `denied` and `not_determined` are
reserved for a future macOS 13 TCC path.

`captured_frames` is volatile and does not force a status publish by itself
inside the metrics interval.

## Helper Events

The helper emits these stdout/event-log events (implemented in PR2/PR3):

- `screen_capture_started`
- `screen_capture_stopped { reason: "user_stop"|"stream_stopped"|"item_closed", code? }`
- `screen_capture_source_changed`
- `screen_capture_picker { event }`
- `screen_capture_error { code, message }`

The bridge force-publishes status for all five event types on Windows/dev
spawns. On macOS packaged app launches go through `/usr/bin/open`, so stdout is
not connected and the 2 s status poll carries the projection change.
`screen_capture_error` also publishes a `meeting_error` with the helper code.
`screen_capture_stopped` publishes a `meeting_error` unless the reason is
`user_stop`.

## Ephemeral Source IDs And Restart

Screen `source_id` values are ephemeral. They must be obtained shortly before
use through `meeting_screen_list` or the OS picker.

Screen capture is not replayed after a helper crash restart:

- macOS picker selections exist only inside the dead helper's picker session.
- Windows `HWND`/`HMONITOR` identities can belong to a different window after
  a restart gap.
- Silently sharing the wrong window is a privacy failure.
- Sharing is a per-session consent-like action, so the webapp offers
  "share again".

## Platform Matrix

| Platform | Support |
| --- | --- |
| macOS 14+ | ScreenCaptureKit system picker, no legacy TCC prompt on the picker path (implemented in PR2/PR3). |
| macOS 13 | Unsupported, `unsupported_os` through `unsupported_reason` (implemented in PR2/PR3). |
| Windows 10 1903+ | Windows Graphics Capture display/window capture (implemented in PR2/PR3). |
| Windows 10 2004+ | Cursor flag supported by the platform backend (implemented in PR2/PR3). |

## Frame-Size Policy

- macOS: ScreenCaptureKit scales capture frames to the Meeting program size.
- Windows: the backend chooses mip-level halving while the source remains at
  least as large as the program size.

## Out Of Scope

- Yellow border customization.
- Zero-copy screen-frame upload.
- Source thumbnails.
- macOS 13 legacy TCC capture path.
- Screen audio.

## Verification

Bridge-side verification:

```bash
npx jest apps/bridge/src/services/meeting --runInBand
npx jest apps/bridge/src/services/relay-command-policy.test.ts apps/bridge/src/services/relay-command-allowlist.test.ts --runInBand
```

Manual helper verification with PR2/PR3 backends:

1. Start the Meeting engine.
2. Call `meeting_screen_list` and confirm `capabilities.supported`.
3. Call `meeting_screen_pick`.
4. Confirm the MJPEG preview and `meeting_status.engine.screen_capture.running`
   transition after the OS picker completes.
