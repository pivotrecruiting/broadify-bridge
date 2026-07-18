# Meeting Keyer and GPU Integration Plan

## Goal

Match the proven Gabriel meeting keyer behavior without importing unrelated
features. A normal WebApp live test must select the native platform keyer,
resolve the CoreML model in development and production, run the current-frame
CoreML path on macOS, and keep the meeting compositor on Metal for ordinary
builder scenes.

## Contract

`Broadify WebApp -> Relay -> Bridge meeting_keyer_configure -> Helper keyer.configure`

- The WebApp does not select Vision or expose manual backend/performance tuning.
- A freshly started helper defaults to `modnet` and selects CoreML on macOS.
- `keyer.get` remains the runtime source of truth for provider, fallback state,
  model path, pipeline mode, mask metrics, and compositor backend.
- Existing command names and response shapes remain backward compatible.

## Broadify WebApp files

- `stores/meeting-builder-store.ts`
  - Add the automatic balanced profile and shared edge tuning constants.
- `app/(pages)/(with-nav)/meeting/builder/components/meeting-builder-page-client.tsx`
  - Stop sending a model and manual performance choice from the live test.
- `hooks/use-meeting-builder-sync.ts`
  - Keep every debounced keyer update on the same zero-config contract.
- `app/(pages)/(with-nav)/meeting/builder/components/keyer-panel.tsx`
  - Remove backend/performance selectors and describe automatic operation.
- `app/(pages)/(with-nav)/meeting/builder/components/meeting-preview-panel.tsx`
  - Remove manual performance downgrade recommendations.
- `messages/de/meeting-builder-page.json`
- `messages/en/meeting-builder-page.json`
  - Add the automatic keyer explanation.
- `app/(pages)/(with-nav)/meeting/builder/components/meeting-builder-page-client.test.tsx`
- `hooks/use-meeting-builder-sync.test.tsx`
  - Prove that WebApp commands omit `model`, use the balanced profile, and send
    the complete Gabriel edge tuning.

## Broadify Bridge files

- `apps/bridge/src/services/meeting/meeting-helper-manager.ts`
  - Resolve a macOS development helper model directory beside the `.app`.
  - Validate and log the resolved CoreML model path before starting the helper.
  - Forward only allowlisted GPU tuning variables through LaunchServices.
  - Pass the Bridge PID so the helper can stop after a parent crash.
  - Promote GPU compositor lifecycle events to structured info logs.
- `apps/bridge/src/services/meeting/meeting-helper-manager.test.ts`
  - Cover environment, macOS app-bundle, normal development, and production
    model directory resolution.
- `apps/bridge/native/meeting-helper/src/pipeline/frame_pipeline.cpp`
  - Port the current-frame fused CoreML path, prevent duplicate async CoreML
    work, and expose the fused pipeline status.
  - Preserve current frame/mask alignment and Gabriel edge refinement behavior.
- `apps/bridge/native/meeting-helper/src/common/options.cpp`
- `apps/bridge/native/meeting-helper/src/main.cpp`
  - Validate forwarded tuning variables and run the parent-process watchdog.
- `apps/bridge/native/meeting-helper/src/keyer/coreml_keyer.h`
- `apps/bridge/native/meeting-helper/src/keyer/coreml_keyer.mm`
- `apps/bridge/native/meeting-helper/src/keyer/gpu_mask_refine.h`
- `apps/bridge/native/meeting-helper/src/keyer/gpu_mask_refine.mm`
  - Port Gabriel's Metal-backed mask refinement with a safe CPU fallback.
- `apps/bridge/native/meeting-helper/src/compose/compositor.cpp`
- `apps/bridge/native/meeting-helper/src/compose/compositor.h`
- `apps/bridge/native/meeting-helper/src/compose/metal_compositor.h`
- `apps/bridge/native/meeting-helper/src/compose/metal_compositor.mm`
  - Keep graphics and cornerbug scenes on Metal and apply unsupported cheap
    overlays after the GPU pass instead of switching the whole frame to CPU.
- `apps/bridge/native/meeting-helper/CMakeLists.txt`
  - Compile and link the GPU refinement implementation on macOS.
- `apps/bridge/native/meeting-helper/tests/guided_mask_refine_test.cpp`
- `scripts/test-meeting-helper-keyer.cjs`
- `scripts/test-meeting-helper-gpu.cjs`
  - Retain isolated correctness gates and add assertions for runtime-relevant
    backend and model status where possible.
- `docs/bridge/architecture/meeting-keyer-rendering-dataflow.md`
- `docs/bridge/dev/meeting-helper-dev-setup.md`
  - Document zero-config selection, model resolution, fused CoreML, Metal
    composition, kill switches, and diagnostic fields.

## Acceptance criteria

- WebApp tests prove no `vision_person_segmentation` model is sent.
- Development helper startup points to the checked-in `models` directory.
- Native keyer self-test reports `provider=coreml`,
  `active_keyer=coreml_modnet`, `fallback_active=false`.
- Native GPU self-test reports `backend=metal`, `passed=true` on macOS.
- A real live-test session reports `keyer_pipeline_mode=fused_coreml` and
  `compositor=metal` for the default builder scene.
- Missing or invalid CoreML models fail visibly instead of silently looking like
  a successful MODNet start.
- Production packaging still places the model under
  `Resources/native/meeting-helper/models`.

## Verification

- Broadify WebApp focused Jest tests, TypeScript lint, and build if feasible.
- Bridge focused Jest tests, `build:bridge`, `build:meeting-helper`, native tests,
  GPU self-test, and keyer self-test.
- `npm run dev` live start followed by `keyer.get` and `state.get` inspection.
- Packaging configuration and release artifact verification review.

## Implementation result

Completed on macOS ARM64:

- WebApp focused Jest: 2 suites, 18 tests passed.
- WebApp CoreML health contract: `coreml_modnet` is typed and treated as healthy.
- WebApp TypeScript lint and production build passed.
- Bridge Jest: 155 suites, 1,726 tests passed.
- Bridge protocol, server, graphics renderer, Electron, and Vite production
  builds passed.
- Native CTest passed.
- LaunchServices tuning overrides use a fixed allowlist and redact values in
  Bridge lifecycle logs.
- The Windows distribution script executes GPU and keyer hardware gates before
  packaging.
- Windows CI verifies the signatures of downloaded ONNX Runtime and DirectML
  NuGet packages before extracting native binaries.
- GPU self-test reported `backend=metal`, `passed=true`, and channel delta zero.
- Keyer self-test reported `provider=coreml`,
  `active_keyer=coreml_modnet`, `fallback_active=false`, and
  `model_hash_ok=true`.
- A real FaceTime camera run with the WebApp-equivalent keyer payload reported
  `keyer_pipeline_mode=fused_coreml`, `compositor=metal`, mask age zero, and a
  960 by 540 refined mask. The enabled cornerbug did not downgrade Metal.

Observed on an Apple M2 Pro at 1280 by 720, the fused path ran at about 19 FPS
with about 60 ms inference time. This matches Gabriel's current-frame behavior
and removes visible mask lag, but it also couples output FPS to inference FPS.

Remaining platform and release gates:

- Real Windows DirectML and D3D11 hardware verification is still required.
- The macOS release artifact verifier reaches and finds the Meeting Helper and
  complete CoreML package, then fails on the unrelated local SDL2 dylib because
  it was built with minOS 15.0 instead of the required 13.0. The Meeting keyer
  tests and model hash verification are not affected by that local SDL2 issue.
