# VCam And Live Test Fact Check

## Scope

This note checks the current behavior against the assumptions raised for:

- when `BroadifyVCam.app` opens
- when macOS System Settings approval is triggered
- whether the WebApp "Live Test" path depends on the VCam extension
- why a camera can appear in the WebApp selector but still produce no preview

All statements below are based on the current code in this repository.

## Verdicts

### 1. "The `BroadifyVCam` window opens on my machine because of `npm run dev`, but this should not happen in production."

Verdict: `Partly correct.`

Facts:

- In local dev, `npm run dev` runs `dev:electron`, and that script always runs `npm run install:vcam-helper` first.
  Source: [package.json](/Users/dennisschaible/Desktop/Coding/broadify-bridge/package.json:12)
- `install:vcam-helper` currently reopens `/Applications/BroadifyVCam.app` during the install flow for development.
  Source: [scripts/install-vcam-helper-macos.sh](/Users/dennisschaible/Desktop/Coding/broadify-bridge/scripts/install-vcam-helper-macos.sh:135)
- The packaged production app does not run `install:vcam-helper` on startup.
  Source: [package.json](/Users/dennisschaible/Desktop/Coding/broadify-bridge/package.json:33)

Conclusion:

- Yes, the window opening at `npm run dev` is currently a dev-only side effect of the install script.
- No, that specific auto-open does not happen just because the production Bridge app starts.

### 2. "The VCam window should only open once the user configures VCam or activates the output in the WebApp."

Verdict: `That is the intended product expectation, but it is not fully what the current code does in dev.`

Facts:

- The virtual camera output path is triggered by `meeting_output_configure` with `target: "virtual_camera"` and `action: "start"`.
  Source: [meeting-command-handler.ts](/Users/dennisschaible/Desktop/Coding/broadify-bridge/apps/bridge/src/services/meeting/meeting-command-handler.ts:238)
- That path calls `virtualCameraStart()`.
  Source: [meeting-helper-client.ts](/Users/dennisschaible/Desktop/Coding/broadify-bridge/apps/bridge/src/services/meeting/meeting-helper-client.ts:168)
- `virtualCameraStart()` first starts FrameBus output and then opens `BroadifyVCam.app`.
  Source: [meeting-helper-client.ts](/Users/dennisschaible/Desktop/Coding/broadify-bridge/apps/bridge/src/services/meeting/meeting-helper-client.ts:168)

Conclusion:

- In production logic, the VCam app is opened when the virtual camera output is started.
- In local dev, it is additionally opened earlier by `install:vcam-helper`.

### 3. "If the extension is already activated, the VCam window should ideally not open again."

Verdict: `Correct as a product expectation, but not implemented today.`

Facts:

- `virtualCameraStart()` always calls `openVcamHelperApp()`.
  Source: [meeting-helper-client.ts](/Users/dennisschaible/Desktop/Coding/broadify-bridge/apps/bridge/src/services/meeting/meeting-helper-client.ts:168)
- `openVcamHelperApp()` does not short-circuit when the extension is already active.
- Instead, it quits any running `BroadifyVCam` instance and launches it again.
  Source: [vcam-helper.ts](/Users/dennisschaible/Desktop/Coding/broadify-bridge/apps/bridge/src/modules/vcam/vcam-helper.ts:151)
  Source: [vcam-helper.ts](/Users/dennisschaible/Desktop/Coding/broadify-bridge/apps/bridge/src/modules/vcam/vcam-helper.ts:317)

Conclusion:

- Your expectation is reasonable.
- The current code does not do that yet.
- Current behavior is: start virtual camera output => reopen helper app every time.

### 4. "The camera selected in the WebApp and triggered by 'Live Test starten' should work independently of the VCam extension window."

Verdict: `Correct.`

Facts:

- The WebApp live camera path goes through `meeting_camera_list`, `meeting_camera_select`, and `meeting_camera_start`.
  Source: [meeting-command-handler.ts](/Users/dennisschaible/Desktop/Coding/broadify-bridge/apps/bridge/src/services/meeting/meeting-command-handler.ts:131)
- These commands talk to the native meeting helper camera capture path, not to the VCam extension.
  Source: [meeting-helper-client.ts](/Users/dennisschaible/Desktop/Coding/broadify-bridge/apps/bridge/src/services/meeting/meeting-helper-client.ts:61)
- The MJPEG preview server and the raw VCam frame server are separate outputs from the same preview frame store.
  Source: [main.cpp](/Users/dennisschaible/Desktop/Coding/broadify-bridge/apps/bridge/native/meeting-helper/src/main.cpp:58)
- The virtual camera output path is separate and uses `output.framebus.start` plus `openVcamHelperApp()`.
  Source: [meeting-helper-client.ts](/Users/dennisschaible/Desktop/Coding/broadify-bridge/apps/bridge/src/services/meeting/meeting-helper-client.ts:168)

Conclusion:

- The WebApp live preview path should work without the macOS system extension being activated.
- The VCam helper window is not required for the basic camera capture preview path.

### 5. "Why did the customer see a camera in the WebApp select, but no camera signal in the WebApp preview?"

Verdict: `There is a code path that makes this entirely possible, even without any VCam involvement.`

Facts:

- Camera listing is done by `camera.list`.
  Source: [control_server.cpp](/Users/dennisschaible/Desktop/Coding/broadify-bridge/apps/bridge/native/meeting-helper/src/control/control_server.cpp:168)
- On macOS, `listCameras()` calls `ensureAuthorization()`, but ignores the result and still enumerates devices.
  Source: [camera_avfoundation.mm](/Users/dennisschaible/Desktop/Coding/broadify-bridge/apps/bridge/native/meeting-helper/src/capture/camera_avfoundation.mm:71)
- Starting the camera uses `camera.start`, and that path does fail if permission is not granted.
  Source: [camera_avfoundation.mm](/Users/dennisschaible/Desktop/Coding/broadify-bridge/apps/bridge/native/meeting-helper/src/capture/camera_avfoundation.mm:122)
- The specific error is `Camera permission was not granted.`
  Source: [camera_avfoundation.mm](/Users/dennisschaible/Desktop/Coding/broadify-bridge/apps/bridge/native/meeting-helper/src/capture/camera_avfoundation.mm:123)

Conclusion:

- A camera can appear in the selector even when actual capture cannot start.
- Therefore, "camera visible in select, but no preview signal" is currently possible if camera permission is missing or denied.
- This behavior is independent of the VCam extension problem.

### 6. "Why did my app once open System Settings automatically, but not on the customer machine?"

Verdict: `Because those are two different failure modes.`

Facts:

- System Settings is opened only when `requestNeedsUserApproval(_:)` is called by Apple's system extension API.
  Source: [ContentView.swift](/Users/dennisschaible/Desktop/Coding/broadify-bridge/apps/bridge/native/vcam-helper/BroadifyVCam/ContentView.swift:126)
- In your recent failing case, the helper app received `OSSystemExtensionErrorDomain error 4`.
- Apple defines error code `4` as `OSSystemExtensionErrorExtensionNotFound`.
  Source: [SystemExtensions.h](/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk/System/Library/Frameworks/SystemExtensions.framework/Headers/SystemExtensions.h:48)
- If the request fails early with `extensionNotFound`, there is no user-approval phase, so `requestNeedsUserApproval(_:)` is never reached.

Conclusion:

- Your machine likely hit a path where Apple requested approval.
- The customer likely hit the earlier `extensionNotFound` path.
- That explains why no System Settings approval window was opened for the customer.

## Additional Findings

### Finding A: Current dev startup behavior is misleading

The dev script currently makes it look like "opening Bridge opens VCam", but that is only because `install:vcam-helper` is part of `dev:electron`.

Source: [package.json](/Users/dennisschaible/Desktop/Coding/broadify-bridge/package.json:12)

Impact:

- It blurs the distinction between:
  - development installation flow
  - production runtime activation flow

### Finding B: Current runtime always reopens the helper app

The runtime path for `virtual_camera.start` currently reopens `BroadifyVCam.app` even when the extension is already active.

Sources:

- [meeting-helper-client.ts](/Users/dennisschaible/Desktop/Coding/broadify-bridge/apps/bridge/src/services/meeting/meeting-helper-client.ts:168)
- [vcam-helper.ts](/Users/dennisschaible/Desktop/Coding/broadify-bridge/apps/bridge/src/modules/vcam/vcam-helper.ts:317)

Impact:

- This does not match the desired UX.

### Finding C: Camera list and camera start are inconsistent with permissions

`camera.list` can still return devices even if camera authorization is not granted, while `camera.start` can fail afterward.

Sources:

- [camera_avfoundation.mm](/Users/dennisschaible/Desktop/Coding/broadify-bridge/apps/bridge/native/meeting-helper/src/capture/camera_avfoundation.mm:71)
- [camera_avfoundation.mm](/Users/dennisschaible/Desktop/Coding/broadify-bridge/apps/bridge/native/meeting-helper/src/capture/camera_avfoundation.mm:122)

Impact:

- The WebApp can present a camera as selectable even though capture will not succeed.
- This is a likely explanation for the customer's "camera selected, but no preview signal" report.

## Direct Answers

### Should the VCam window open on every Bridge launch?

No, not as product behavior.

Current reality:

- `yes` in local dev because of `install:vcam-helper`
- `no` as a normal production startup behavior
- `yes` when virtual camera output is started, because that is how the current runtime path is implemented

### Should the VCam helper reopen after successful activation?

Ideally no.

Current reality:

- Yes, it currently reopens whenever `virtual_camera.start` is triggered.

### Should WebApp live camera preview be independent from VCam?

Yes.

Current reality:

- It is independent in the code.
- A broken VCam extension should not by itself break the standard camera preview path.

### Why might a customer see a camera but no preview?

Most likely from the current camera permission behavior:

- camera is listed
- permission is missing or denied
- camera start fails
- preview stays empty

That is a separate issue from the VCam extension activation failure.

## Recommended Next Changes

1. Remove `install:vcam-helper` from the default `dev:electron` path, or gate the helper reopen behind an explicit dev flag.
2. Change `virtualCameraStart()` so it does not reopen `BroadifyVCam.app` if the extension is already active.
3. Tighten `camera.list` / `camera.start` permission behavior so the WebApp cannot present a false-positive selectable camera without a clear permission error.
4. Continue investigating the `OSSystemExtensionErrorExtensionNotFound` root cause for the helper app container path, because that is the concrete VCam activation blocker seen both locally and at the customer.
