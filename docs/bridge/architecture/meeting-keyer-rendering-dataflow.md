# Meeting Keyer And Rendering Dataflow

## Summary

This document describes the current meeting keyer and rendering pipeline as it
exists in code. It focuses on the Apple Vision keyer path, alpha mask handling,
frame composition, graphics layering, preview, and FrameBus output.

The current architecture now keeps the camera RGB frame and alpha mask paired at
the async keyer boundary. The keyer still runs asynchronously, but the compositor
does not apply an old mask to the current camera frame. It applies each mask only
to the RGB frame that produced it, then uses `max_mask_age_ms` as a safety cutoff
before falling back to passthrough. The current compositor also renders a fully
opaque program frame, even when the configured background mode is named
`transparent`.

## Control Plane Dataflow

The web app controls the meeting helper through the Bridge and Relay command
path.

1. `hooks/use-meeting-builder-sync.ts` converts Meeting Builder state into
   command payloads.
2. `lib/bridge-commands.ts` sends `meeting_*` commands through the web app
   command route and Relay.
3. `apps/bridge/src/services/meeting/meeting-command-handler.ts` validates and
   dispatches those commands inside the Bridge.
4. `MeetingHelperClient` sends JSON-RPC requests over the native helper control
   socket.
5. `apps/bridge/native/meeting-helper/src/control/control_server.cpp` mutates
   `MeetingState`.

Important command mappings:

- `meeting_keyer_configure` -> `keyer.configure`
- `meeting_keyer_get` -> `keyer.get`
- `meeting_program_update` -> `program.update`
- `meeting_output_configure` -> `output.framebus.*`
- `meeting_graphics_configure_outputs` -> meeting graphics FrameBus setup

The web app currently sends keyer configuration with:

- `enabled`: Meeting Builder keyer feature state
- `model`: `modnet` or `vision_person_segmentation`
- `background_mode`: always `transparent` from the builder sync
- `mask_erode_px`: `0.5` for `vision_person_segmentation`, `0` for other keyers
- `edge_stabilization_enabled`: `true` for `vision_person_segmentation`
- `edge_stabilization_strength`: `0.35` for `vision_person_segmentation`
- no explicit `quality_mode`, `mask_dilate_px`, `mask_feather_px`, or
  `dynamic_dilation` in the builder sync path

The native defaults in `MeetingState` are:

- `requestedKeyerModel = "modnet"`
- `qualityMode = "balanced"`
- `maskErodePx = 0`
- `maskDilatePx = 0`
- `maskFeatherPx = 0`
- `dynamicDilation = false`
- `temporalBlendEnabled = true`
- `edgeStabilizationEnabled = true`
- `edgeStabilizationStrength = 0.35`
- `freshMaskAgeMs = 60`
- `maxMaskAgeMs = 220`
- `backgroundMode = "transparent"`

Practical consequence: when the WebApp selects
`vision_person_segmentation` and does not send an explicit `quality_mode`, Apple
Vision runs in `balanced` mode. This is the current quality-first baseline.
`fast` remains useful only as an A/B diagnostic mode because it reduced edge
quality in real preview tests.

## Performance Profiles

`meeting_keyer_configure` accepts `performance_mode` independently from the
selected keyer model and `quality_mode`. The value is validated as one of
`high_quality`, `quality`, `balanced`, or `performance`.

- `high_quality`: 30 keyer FPS, Vision `balanced`, maximum Vision input 1280x720.
- `quality`: 25 keyer FPS, Vision `balanced`, maximum Vision input 1280x720.
- `balanced`: 20 keyer FPS, Vision `balanced`, maximum Vision input 960x540.
- `performance`: 15 keyer FPS, Vision `fast`, maximum Vision input 640x360.

The program output remains 1280x720 at 30 FPS in all profiles. The helper
uses a latest-frame scheduler, so skipped capture frames are intentional and
reported as `metrics.skipped_frames`; they never queue behind old work. MODNet
keeps its fixed 512x512 ONNX input and benefits from the rate limit.

The WebApp stores the chosen profile locally per device rather than in a shared
meeting scene. It may recommend one lower profile after five seconds of
insufficient keyer FPS, elevated mask age, or sustained frame drops, but it
never changes the profile automatically.

## Native Runtime Topology

`MeetingHelperManager` starts the native `meeting-helper` process with:

- output width, height, and FPS
- output FrameBus name, default `broadify-meeting-framebus`
- JSON-RPC control socket path
- MJPEG preview port
- models directory

Inside the native helper, the relevant long-running components are:

- `CameraSource`: captures the latest camera frame.
- `AsyncKeyerWorker`: runs the selected keyer on a background thread.
- `GraphicsFrameBusReader`: reads the latest meeting graphics frame from
  `bfy-meet-gfx`.
- `renderProgramFrame`: composites the final program frame.
- `framebus_writer_write_rgba`: writes the final program frame to the meeting
  output FrameBus.
- `PreviewFrameStore`: publishes the same final program frame to MJPEG preview.

The native pipeline is `latest-frame-wins`. It does not queue every camera frame
for keying. If a keyer frame is already pending, submitting another frame drops
the previous pending frame and increments `droppedFrames`.

## Camera Capture

On macOS, `camera_avfoundation.mm` uses `AVCaptureVideoDataOutput` with
`kCVPixelFormatType_32BGRA`.

For every sample buffer:

1. The pixel buffer is locked read-only.
2. BGRA bytes are copied into a new `VideoFrame`.
3. Channels are converted to RGBA.
4. `timestampNs` is set to `nowNs()`, not the camera sample timestamp.
5. The frame becomes `latestFrame_`.

Late camera frames are discarded by AVFoundation through
`alwaysDiscardsLateVideoFrames = YES`.

Important consequence: timestamp comparisons are based on helper wall-clock
capture time, not native camera presentation timestamps.

## Keyer Selection

`KeyerChain::process` reads `MeetingState` and routes each submitted frame:

- disabled keyer -> passthrough frame, fallback reason `keyer_disabled`
- `modnet` -> `ModnetKeyer`
- `vision_person_segmentation` -> `VisionKeyer`
- anything else -> passthrough frame, fallback reason `unsupported_model`

The returned `KeyerResult` contains:

- a copied RGBA frame
- an `AlphaMask`
- a `KeyerStatus`

In the current async pipeline, the published `AlphaMask` is the important
artifact. The keyed RGBA frame returned by the keyer is not the frame that the
program compositor usually displays.

## Apple Vision Keyer Path

`vision_keyer.mm` implements `VisionKeyer`.

For each submitted frame:

1. The RGBA frame is wrapped as a `CGImage`.
2. A cached `VNGeneratePersonSegmentationRequest` on the `VisionKeyer`
   implementation is reused.
3. A cached `VNSequenceRequestHandler` on the `VisionKeyer` implementation is
   reused.
4. `qualityLevel` is set from normalized `quality_mode`:
   - `fast`
   - `balanced`
   - `accurate`
5. `outputPixelFormat` is `kCVPixelFormatType_OneComponent8`.
6. Vision returns a `VNPixelBufferObservation`.
7. The one-channel mask is copied into `AlphaMask`.
8. `applyMaskToFrame` writes mask alpha into a copy of the input frame.

`applyMaskToFrame` uses nearest-neighbor sampling from mask resolution to frame
resolution. Later in the real compositor boundary, `applyLatestAlphaToCurrentFrame`
uses bilinear alpha sampling. That means there are two different mask sampling
implementations in the codebase, but the async compositor path depends on the
bilinear one.

There is no explicit Vision temporal-reset logic when cameras switch or keyer
settings change beyond clearing the async worker state. The Vision sequence
handler instance is retained inside the keyer implementation.

## MODNet Keyer Path

`modnet_keyer.cpp` implements the MODNet path.

Load behavior:

- reads the model manifest
- verifies model file existence
- requires a real SHA-256 value
- attempts CoreML provider on Apple platforms
- falls back to CPU provider if CoreML registration fails
- uses up to four CPU inference threads

Per submitted frame:

1. RGBA input is resized to model input dimensions.
2. RGB is normalized with ImageNet mean/std values.
3. ONNX Runtime runs inference.
4. The float mask is copied to `AlphaMask`.
5. The mask is applied to a copied RGBA frame.

The input tensor resize uses nearest-neighbor sampling. The final mask to
current-frame application in the async pipeline uses bilinear alpha sampling.

## Async Keyer Worker

The keyer worker is created inside `runFramePipeline`.

Main-thread behavior per output frame:

1. Copy latest camera frame.
2. If keyer is enabled, submit that camera frame to `AsyncKeyerWorker`.
3. Ask the worker for the latest paired camera frame and mask.
4. If a usable pair exists, apply the mask to the paired camera frame.
5. If no usable pair exists, pass the current camera frame through unchanged.

Worker-thread behavior:

1. Wait for the latest pending frame.
2. Run `KeyerChain::process`.
3. Copy the previous published mask if present.
4. Read current keyer settings and the last reported `maskAgeMs`.
5. Run temporal alpha blending.
6. Run alpha postprocessing.
7. Publish the new mask if generation still matches.
8. Update keyer status in `MeetingState`.

This is the core sync boundary: RGB and alpha in the keyed camera layer come from
the same submitted camera frame. `mask_age_ms` is still computed against the
current camera frame so the system can report how delayed the visible keyed pair
is:

```text
current_frame.timestampNs - paired_frame.timestampNs
```

If the person moves between those timestamps, alpha can visibly lag behind the
person.

## Alpha Postprocessing

Alpha postprocessing runs on the `AlphaMask` before it is published.

Current steps:

1. `remapAlphaSmoothstep`
   - maps alpha through `smoothstep(0.12, 0.88, alpha)`
   - suppresses weak alpha and strengthens high alpha
2. `blendAlphaTemporal`
   - blends current mask with previous mask when dimensions and timestamps are
     compatible
3. `stabilizeAlphaEdges`
   - blends only uncertain alpha-edge pixels with the previous mask
   - motion-gated so large alpha changes keep the current mask and do not
     recreate transparency trails
   - age-gated: full strength below `40 ms` mask age, fades down until
     `75 ms` so moving paired frames do not retain old edge alpha strongly
4. `erodeAlpha`
   - fractional min-filter radius; subpixel values interpolate between the
     original mask and integer-radius erosion
   - used conservatively by the WebApp with `mask_erode_px = 0.5` for Vision to
     remove visible background rim without the hard 1px cut
5. `dilateAlpha`
   - max filter with configured or dynamic radius
6. `featherAlpha`
   - box blur with configured radius

Important constants:

- `kTemporalAlphaMaxAgeNs = 250000000` (250ms)
- `kStaleMaskAgeMs = 140.0`
- `kQuietPreviousWeight = 0.85`
- `kMotionPreviousWeight = 0.35`
- `kStalePreviousWeight = 0.12`
- `kTemporalProtectionRadiusPx = 10`
- `kTemporalProtectionAlphaThreshold = 32`
- `kMaxAlphaDilateRadiusPx = 8`
- `kMaxAlphaFeatherRadiusPx = 3`

The temporal blend is protected by a dilated current-mask zone. Pixels outside
that zone are not blended with previous alpha. Pixels inside the zone can retain
substantial previous alpha, especially when the current and previous alpha are
similar.

This can stabilize flicker, but it can also create perceived trailing during
motion because old alpha is intentionally retained near the current mask.

## Applying The Latest Mask

The async keyer publishes a paired camera frame and alpha mask from the same
submitted capture frame. The program loop applies the mask only to that paired
camera frame. This removes the previous RGB/mask mismatch where a stale mask was
applied to the current camera RGB frame.

Current stages:

- `fresh`: paired frame age below `fresh_mask_age_ms`; paired hard keying.
- `paired`: paired frame age between `fresh_mask_age_ms` and
  `max_mask_age_ms`; still uses the synchronized RGB/mask pair and marks
  `stale_mask_active`.
- `passthrough`: paired frame age above `max_mask_age_ms` or no usable pair;
  renders the current camera without keying.

`applyLatestAlphaToCurrentFrame` copies the paired camera frame and replaces
only the alpha channel using the paired mask.

Behavior:

- RGB comes from the paired camera frame that produced the mask.
- Alpha comes from the paired mask.
- Mask-to-frame scaling uses bilinear sampling.
- No motion compensation is performed; the entire keyed camera layer is delayed
  as one synchronized pair.
- When `mask_age_ms` is above `max_mask_age_ms`, the program loop stops using
  the paired keyer output and passes the current camera frame through.
- Hard mask-age cutoffs prevent very old masks from being used for hard keying.
  Very old masks degrade to passthrough.

The output of this function is the paired keyed camera frame used by the
compositor.

## Live Statusbar Metrics

The native `keyer.get` response exposes the current keyer status and metrics.
The Meeting Builder preview statusbar polls `meeting_keyer_get` while the
preview is running and the keyer feature is enabled.

Displayed values:

- `active_keyer`: selected/active keyer, for example `vision_person_segmentation`
- `quality_mode`: current Vision quality mode; `balanced` is the current
  baseline
- `backend`: native backend reported by the helper
- `inference_ms`: total keyer apply time
- `metrics.camera_copy_ms`: camera frame copy cost in the program loop
- `metrics.tensor_ms`: model input/tensor preparation cost
- `metrics.session_run_ms`: model/Vision run cost
- `metrics.mask_apply_ms`: mask application cost
- `metrics.mask_dilate_ms`: erode/dilate phase cost
- `metrics.mask_postprocess_ms`: mask postprocess cost
- `metrics.mask_age_ms`: age of the paired keyer frame relative to the current
  program frame
- `metrics.mask_age_avg_ms`: rolling average mask age over the latest program
  frames
- `metrics.keyer_input_age_ms`: age of the submitted camera frame when the
  async keyer starts processing it
- `metrics.keyer_processing_ms`: worker processing time from keyer start to
  pair publish
- `metrics.keyer_publish_to_program_ms`: time between publishing a paired
  keyer frame and using it in the program loop
- `metrics.program_frame_interval_ms`: measured interval between program-frame
  starts
- `metrics.program_frame_ms`: full program-frame render/write cost
- `metrics.mjpeg_encode_ms`: preview MJPEG encode cost when available
- `metrics.keyer_fps`: rolling published keyer-result rate
- `metrics.program_fps`: rolling program-frame rate
- `metrics.dropped_frames_per_sec`: rolling async keyer drop rate
- `metrics.mask_width` and `metrics.mask_height`: produced mask resolution
- `metrics.dropped_frames`: total async keyer worker drops since reset/clear
- `metrics.skipped_frames`: capture frames intentionally skipped by the active
  performance-profile scheduler
- `settings.mask_erode_px`: configured mask erosion radius shown as `Erode` in
  the WebApp statusbar
- `settings.edge_stabilization_enabled`: shown as `Edge stab` in the WebApp
  statusbar
- `settings.edge_stabilization_strength`: shown as `Edge strength` in the
  WebApp statusbar
- `degradation_stage`: `fresh`, `paired`, or `passthrough`

These values are the main decision surface for Phase 2 latency work. If
`session_run_ms` dominates, the next target is the Vision path. If
`camera_copy_ms` or `program_frame_ms` dominates, the next target is capture,
copy, or compositing.

The program loop uses deadline-based frame pacing. Render/write time is part of
the target frame interval; it is not followed by a full fixed-frame sleep. This
keeps `program_fps` close to the configured output FPS when rendering completes
within budget.

Before rendering, the program loop performs a final non-blocking check for a
newer paired keyer frame. If the async keyer published a fresher pair during
program-loop preparation, that pair is used immediately without blocking the
program frame.

## Program Composition And Layering

`renderProgramFrame` builds a single program RGBA buffer in this order:

1. `fillBackground`
2. `drawMediaLayer`
3. `drawGraphicsFrame`
4. `drawCamera`
5. `drawGraphics`
6. `drawCornerbug`

Actual layering:

- Background is always the bottom layer.
- Native media placeholder is drawn above background.
- Meeting graphics FrameBus layer is drawn above media.
- Keyed camera/person is drawn above meeting graphics.
- Native placeholder lower-third graphics are drawn above camera.
- Native cornerbug placeholder is drawn last.

`drawCamera` scales/crops the camera frame into `cameraRect`. If speaker layout
is disabled, the camera rect is full-frame. If speaker layout is enabled, the
camera is placed as a portrait-style rectangle.

The compositor mirrors only the camera layer by default. This mirror is applied
inside `drawCamera` while sampling the camera source X coordinate, so
backgrounds, rendered graphics, lower thirds, and text remain unmirrored in the
program frame. The runtime setting is the `camera` program section:
`{"mirror": true | false}`.

The virtual camera extension consumes the final program frame as-is. Its raw
frame reader only converts RGBA to BGRA for CMIO and must not apply another
horizontal flip, otherwise the complete output, including graphics and text,
would be mirrored for remote meeting participants.

`blendPixel` uses straight alpha blending:

```text
dst.rgb = src.rgb * src.a + dst.rgb * (1 - src.a)
dst.a = 255
```

The destination alpha is forced to `255` for blended pixels.

## Background Transparency Reality

`fillBackground` starts with:

```text
frame.assign(width * height * 4, 255)
```

Then each pixel is written through `setPixel`, whose default alpha is `255`.

When `backgroundMode == "transparent"`, the RGB values are set to black, but
alpha remains `255`. In the meeting program path this is intentional P0
semantics: the output is a finished opaque program frame, not an alpha-preserved
key/fill layer.

Current reality:

- `transparent` means black opaque background in the final program frame.
- The meeting output FrameBus receives a fully composited opaque RGBA image.
- Alpha from the person mask is consumed during composition and not preserved as
  output alpha.

This is important when reasoning about virtual-camera output: the program output
is not a transparent keyed person layer. It is a finished composited frame.

## Meeting Graphics FrameBus Layer

Meeting graphics are rendered by the regular graphics renderer into a separate
FrameBus named `bfy-meet-gfx`.

`GraphicsFrameBusReader`:

- opens `bfy-meet-gfx`
- reads the latest RGBA frame
- keeps the last successful frame if no new frame is available
- logs frame dimensions, sequence, non-transparent pixel count, and max alpha

`drawGraphicsFrame` composites that graphics frame into the program frame using
straight alpha blending. It uses cover-style scaling/cropping to fit the meeting
program dimensions.

The Meeting Builder currently sends:

- background template as layer `meeting-background-template`, z-index `0`
- content template as layer `meeting-content-template`
- both with `backgroundMode: "transparent"`

These graphics are not inserted directly into the C++ compositor as independent
semantic layers. They arrive as one rendered RGBA graphics frame over FrameBus.

## Output And Preview Dataflow

The final `programFrame` is written to:

- meeting output FrameBus through `framebus_writer_write_rgba`
- MJPEG preview through `PreviewFrameStore`

The native helper exposes FrameBus status through `output.framebus.status`.
Virtual camera status in `MeetingHelperClient` explicitly reports that virtual
camera is provided by the separate `vcam-helper`.

Therefore:

- Meeting helper produces the program frame.
- VCam helper consumes the meeting output through the local raw-frame stream.
  The stream now prefers BGRA payloads so the CMIO extension can copy live
  frames without per-pixel channel conversion; RGBA remains accepted for
  compatibility.
- VCam helper uses a lazy reader lifecycle: no raw-stream reader when no CMIO
  client is streaming, 1 FPS cached no-signal output in idle, and 30 FPS output
  only while fresh program frames are available.
- Meeting helper does not own virtual camera lifecycle internally.

## Observability

`keyer.get` exposes:

- active keyer
- fallback state and reason
- degradation stage and stale-mask state
- backend/provider/model path
- quality mode
- inference time
- model hash status
- metrics

Metrics currently include:

- `camera_copy_ms`
- `tensor_ms`
- `session_run_ms`
- `mask_apply_ms`
- `mask_dilate_ms`
- `mask_postprocess_ms`
- `mask_age_ms`
- `program_frame_ms`
- `mjpeg_encode_ms`
- `mask_width`
- `mask_height`
- `dropped_frames`
- `degradation_stage`
- `stale_mask_active`

The most relevant motion diagnostics are:

- `mask_age_ms`
- `dropped_frames`
- `session_run_ms`
- `program_frame_ms`
- `mask_width`
- `mask_height`

## Known Weakness Candidates

These are code-derived candidates, not proven runtime root causes.

1. Keyed layer delay
   - The compositor applies each mask to its paired camera RGB frame.
   - Fast motion should no longer reveal offset alpha, but the whole keyed
     camera layer can lag by `mask_age_ms`.

2. Temporal alpha retention
   - Previous alpha can contribute up to `0.85` in quiet areas.
   - This can reduce flicker but can also preserve old matte near the person.

3. Stale-mask tolerance
   - Masks can be reused within a 250ms timestamp window.
   - `kStaleMaskAgeMs` reduces previous-mask contribution after 140ms, but it
     does not prevent using the stale mask.

4. Resolution and sampling mismatch
   - Vision and MODNet masks can be lower resolution than the camera frame.
   - Final mask application is bilinear, but earlier keyer-local application
     paths still contain nearest-neighbor sampling.

5. CPU copy cost
   - Camera frames are copied BGRA -> RGBA on CPU.
   - Vision wraps RGBA as `CGImage`.
   - Masks are copied into `std::vector<uint8_t>`.
   - Program composition loops over pixels on CPU.
   - These copies can increase keyer latency and therefore `mask_age_ms`.

6. Opaque final program
   - `transparent` background is currently black with alpha `255`.
   - If downstream systems expect preserved alpha, the current meeting program
     output does not provide it.

7. Straight-alpha composition
   - The compositor blends straight alpha and forces destination alpha to `255`.
   - Any premultiplied-alpha assumption from upstream graphics would produce
     incorrect edges.

8. Camera timestamp source
   - Camera frames use `nowNs()` when copied, not sample presentation time.
   - This is good enough for helper-local age measurement, but not a true camera
     timeline.

## Practical Debug Checklist

For motion trailing:

- Watch `mask_age_ms` while moving hands and shoulders quickly.
- Compare `session_run_ms` across `fast`, `balanced`, and `accurate`.
- Watch `dropped_frames`; pending keyer frames are overwritten.
- Temporarily disable temporal blend in code or reduce previous weights to
  isolate trailing from model latency.
- Test with `mask_dilate_px = 0`, `mask_feather_px = 0`, and
  `dynamic_dilation = false`.

For pixelated or dirty edges:

- Check `mask_width` and `mask_height` from `keyer.get`.
- Compare Vision quality modes.
- Test `mask_erode_px = 0.25..1.0` for background rim removal; keep the lowest
  value that removes the rim without eating hair, ears, or fingers.
- Inspect whether artifacts appear before or after final bilinear upscale.
- Verify upstream graphics are straight-alpha compatible.
- Confirm the selected camera resolution; AVFoundation currently uses
  `AVCaptureSessionPresetHigh`, not an explicit format lock to the helper output
  size.

For unexpected black background:

- Treat `background_mode: "transparent"` as opaque black in the meeting program
  until `fillBackground` and compositor output alpha semantics are changed.
