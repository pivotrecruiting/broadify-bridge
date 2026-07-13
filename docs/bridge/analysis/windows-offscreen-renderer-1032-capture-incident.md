# Windows Offscreen Renderer 1920x1032 Capture Incident

## Status

- Incident observed during customer setup before a live presentation.
- Runtime hotfix was not shipped because the customer confirmed a non-code workaround.
- Keep this document as the basis for the next planned fix and regression test.

## Customer Symptom

- HDMI graphics output stopped showing graphics.
- Bridge/graphics logs repeatedly showed renderer downsample failures.
- The issue occurred on Windows with a 1920x1080 graphics output configuration.

Representative log:

```json
{
  "level": 40,
  "msg": "[GraphicsRenderer] Frame downsample failed (single)",
  "message": "Downsample dimensions must use positive integer scale factors.",
  "imageWidth": 1920,
  "imageHeight": 1032,
  "width": 1920,
  "height": 1080
}
```

The captured offscreen image was `1920x1032`, while the renderer and FrameBus session expected `1920x1080`.

## Current Code Path

- Offscreen renderer entry: `apps/bridge/src/services/graphics/renderer/electron-renderer-entry.ts`
- The single renderer creates a hidden Electron `BrowserWindow`.
- The renderer receives paint frames via `webContents.on("paint", ...)`.
- Captured BGRA frames are converted to RGBA and normalized through `normalizeCapturedRgbaFrame`.
- If source and target dimensions differ, `downsampleRgbaBox` requires integer downsample factors.

For `1920x1032 -> 1920x1080`, scale factors are invalid because this is not a downsample. The code logs the warning and returns before writing to FrameBus. This blocks HDMI/display graphics output.

## Likely Root Cause

The most likely cause is Windows/Electron sizing the offscreen `BrowserWindow` by outer window bounds instead of content bounds.

Observed mismatch:

- Expected content/frame: `1920x1080`
- Captured content: `1920x1032`
- Difference: `48px`

That 48px delta is consistent with Windows non-client area such as a title bar/window frame, or a work-area constraint involving the taskbar. The current renderer window creation does not explicitly request content-sized frameless bounds.

## Confirmed Workaround

The customer tested:

1. Hide Windows taskbar only.
2. Reconfigure outputs.
3. Result: not fixed.

Then:

1. Hide Windows taskbar.
2. Fully restart the Bridge.
3. Result: graphics output worked again.

This strongly supports a startup-time Electron/Windows bounds calculation issue. Output reconfiguration alone does not necessarily recreate the offscreen renderer with corrected bounds.

## Planned Code Fix

For the next planned update, create the offscreen renderer window with content-sized frameless bounds:

```ts
singleWindow = new BrowserWindow({
  width: renderWidth,
  height: renderHeight,
  useContentSize: true,
  frame: false,
  show: false,
  transparent: true,
  paintWhenInitiallyHidden: true,
  webPreferences: {
    offscreen: true,
    backgroundThrottling: false,
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
  },
});
```

Rationale:

- `useContentSize: true` makes `width` and `height` apply to the web contents area.
- `frame: false` removes title bar and non-client frame from the renderer window.
- The renderer remains hidden and offscreen; this does not introduce a visible UI path.

## Regression Test Plan

Add/keep a unit test that verifies the offscreen renderer `BrowserWindow` is created with:

- `width: 1920`
- `height: 1080`
- `useContentSize: true`
- `frame: false`
- `webPreferences.offscreen: true`

Run targeted tests:

```bash
npx jest --runInBand apps/bridge/src/services/graphics/renderer/electron-renderer-entry.test.ts apps/bridge/src/services/graphics/renderer/graphics-pixel-utils.test.ts
```

Manual Windows validation after a planned build:

1. Start Bridge on Windows with taskbar visible.
2. Configure HDMI/display graphics output to `1920x1080`.
3. Send a graphics layer.
4. Confirm logs contain `First FrameBus frame written`.
5. Confirm the first frame log reports `renderWidth: 1920` and `renderHeight: 1080`.
6. Confirm no repeated `Downsample dimensions must use positive integer scale factors` warnings.
7. Repeat with taskbar auto-hide disabled and enabled.
8. Repeat after output reconfiguration without full Bridge restart.

## Operational Guidance Before Fix Ships

For live-show situations where updating shortly before the event is too risky:

1. Enable Windows taskbar auto-hide.
2. Fully restart Broadify Bridge after changing taskbar/work-area state.
3. Reconfigure graphics outputs if needed.
4. Send a test graphic.
5. Verify logs no longer show `imageHeight: 1032`.

If the warning remains after restart, collect:

- Full graphics renderer logs from Bridge startup through first graphics send.
- Output configuration payload.
- Windows display resolution and scale percentage.
- Whether taskbar is visible, auto-hidden, or placed on another screen edge.
- Whether the target is HDMI display output, DeckLink output, or another output adapter.

## Risk Notes

- The proposed code fix is narrow and limited to offscreen renderer window creation.
- It does not reintroduce legacy graphics paths.
- It does not change FrameBus, renderer IPC, command validation, or output adapters.
- The primary risk is Electron/Windows behavior differences across versions, so the fix should be validated on the same Windows display setup class before release.
