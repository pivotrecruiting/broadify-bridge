# Task: Windows MODNet input fills the square tensor (no letterbox bars)

## Raw request
Gabriel (founder), 2026-10-17, on RC v0.27.3-rc.6 (model ft-v7d) on his Windows laptop (GTX 1660 Ti):
"der Key frisst auf Windows extrem" = the keyer cuts parts of the person away. He approved building the fix
and merging it into `dev` for the next RC (not main, not prod). "Extrem sauber arbeiten, keine Annahmen treffen."

Evidence (measured, broadify-keyer-training/models/results/win-fressen-20261017/BEFUND.md):
- Windows letterboxes the camera frame into an N x N tensor with mid-grey bars (matting_common.cpp:90-120).
  Field log of his laptop: governor tier `performance` (N=256) / `balanced` (N=320). At N=256 a 1920x1080
  frame keeps only 256x144 content pixels.
- Share of the true person lost (ft-v7d, lab set, clean / webcam): letterbox 256: 8.84 % / 11.17 %;
  letterbox 320: 3.37 % / 5.94 %; letterbox 512: 1.24 % / 2.64 %.
  Same tensor size, frame STRETCHED over the full square (= macOS production path in coreml_keyer.mm and
  the training geometry in broadify-keyer-training/scripts/fabrik.py): 256: 3.87 % / 4.89 %;
  320: 2.64 % / 3.48 %; 512: 1.19 % / 2.44 %.
- Tensor shapes per tier must NOT change: DirectML compiles kernels for the first Run shape; another shape
  recompiles every Run (modnet_keyer.cpp comment, measured 145 ms -> 2.4 s). Sessions are prebuilt per
  square size (512/320/256).

## Context
- Worktree / branch: /Users/gabrielbaeuerle/broadify-bridge-worktrees/keyer-win-fill-input, feature/keyer-win-fill-input
- Base branch: dev (d458791f, version 0.27.3-rc.6)
- Code root: apps/bridge/native/meeting-helper/

## Plan
1. `src/keyer/matting_common.h/.cpp`
   - Add `enum class ModnetInputGeometry { Letterbox, Fill };`.
   - Extend `ModnetLetterboxMapping` (keep the name) with `ModnetInputGeometry geometry = Letterbox;`
     plus `uint32_t maskOutputWidth = 0; uint32_t maskOutputHeight = 0;`. For the existing letterbox mapping,
     `maskOutputWidth/Height` = `contentWidth/Height` (no behavior change).
   - Add `ModnetLetterboxMapping modnetFillMapping(sourceW, sourceH, inputW, inputH)`: `geometry = Fill`,
     `contentX = contentY = 0`, `contentWidth = inputW`, `contentHeight = inputH`, and
     `maskOutputWidth/Height` = the `contentWidth/Height` that `modnetLetterboxMapping(sourceW, sourceH, inputW, inputH)`
     returns for the same arguments (so the emitted mask keeps exactly today's dimensions, e.g. 512x288,
     320x180, 256x144 for a 1920x1080 frame). Zero dimensions behave like `modnetLetterboxMapping` (empty mapping).
   - Add a pure, unit-testable selector
     `ModnetInputGeometry modnetInputGeometryFor(bool isWindows, const char *letterboxEnvValue)`:
     returns `Letterbox` when `!isWindows`, or when `letterboxEnvValue` is exactly `"1"`; otherwise `Fill`.
     And `ModnetInputGeometry modnetInputGeometryForThisPlatform()` that reads
     `std::getenv("BROADIFY_MEETING_KEYER_LETTERBOX")` ONCE (function-local static) and passes
     `isWindows = defined(_WIN32)`.
   - Add `ModnetLetterboxMapping modnetInputMapping(sourceW, sourceH, inputW, inputH, ModnetInputGeometry)`
     dispatching to the two mapping functions.
   - `buildModnetInputTensor(...)`: add a trailing parameter `ModnetInputGeometry geometry = ModnetInputGeometry::Letterbox`
     and build the mapping via `modnetInputMapping`. The integer block-average loop already maps x and y
     independently, so Fill needs no new sampling code. Letterbox output must stay byte-identical.
   - `copyModnetAlphaMask(...)`: when `mapping.geometry == Fill`, resample the FULL model output
     (`maskWidth x maskHeight`) to `maskOutputWidth x maskOutputHeight` with separable bilinear interpolation,
     pixel-centre aligned like OpenCV INTER_LINEAR: `src = (dst + 0.5) * srcExtent / dstExtent - 0.5`, clamped to
     `[0, srcExtent - 1]`, weights from the fractional part, values clamped to [0,1] then
     `uint8 = round(alpha * 255)` exactly like the existing branch. When output dims equal the mask dims,
     copy 1:1 (identity). The Letterbox branch must stay byte-identical (keep the existing code path).
     Keep the null/zero-dimension early returns.
2. Call sites (Windows paths; keep macOS untouched):
   - `src/keyer/modnet_keyer.cpp`: every `buildModnetInputTensor` / `modnetLetterboxMapping` call in `apply()`
     (CPU path, zero-copy device path incl. its CPU parity reference, fp16 path) must use the SAME geometry,
     taken from `modnetInputGeometryForThisPlatform()`, so the zero-copy parity gate keeps comparing like with
     like. `copyModnetAlphaMask` receives the mapping that built the tensor. Do not change session shapes,
     tier sizes, probes or the prebuild set.
   - `src/keyer/openvino_keyer.cpp`: same for its `buildModnetInputTensor` / `copyModnetAlphaMask` calls.
   - `src/keyer/dml_device_input.cpp/.h`: the HLSL shader already takes contentX/Y/Width/Height and maps x/y
     independently, so a Fill mapping (content == whole tensor) works without shader changes. Verify that
     `buildDeviceTensor`'s validation still accepts the Fill mapping (input dims unchanged). Only update comments
     that claim "letterbox" is the only geometry.
   - Emit one stdout line when a keyer session is (re)loaded, in the same style as the existing
     `{"type":"meeting_keyer",...}` lines: `{"type":"meeting_keyer","event":"input_geometry","geometry":"fill"}`
     (or `"letterbox"`). Once per process is enough.
3. Docs: `docs/bridge/features/meeting-keyer-windows.md` (and `docs/bridge/architecture/meeting-keyer-rendering-dataflow.md`
   only if it describes the Windows letterbox): Windows now stretches the full frame into the N x N tensor like
   macOS; emitted mask dimensions are unchanged; kill switch `BROADIFY_MEETING_KEYER_LETTERBOX=1` restores the
   letterbox (Windows inherits the full environment, so a line in `%APPDATA%\Broadify Bridge RC\.env` works).
   Include the measured numbers above and their source path.
4. Tests in `tests/matting_common_test.cpp` (ctest target `matting_common_test`, pure stdlib, runs on macOS):
   - `modnetFillMapping(1920,1080,512,512)`: content 0,0,512,512; maskOutput 512x288; geometry Fill.
     Same for 320 (320x180) and 256 (256x144). Zero dims -> empty mapping like the letterbox function.
   - Letterbox mapping now also reports maskOutput == content dims.
   - `buildModnetInputTensor` with Fill on a small synthetic RGBA frame (e.g. 8x4 with distinct colours per
     2x1 block -> 4x4 tensor): every element equals the normalized block average of its stretched source block;
     no element equals the 0.0 padding unless the source block averages to mid-grey.
   - `copyModnetAlphaMask` with Fill: a hand-computed bilinear case (e.g. 4x4 model mask -> 4x2 output for an
     8x4 source) with exact expected uint8 values; identity copy when maskOutput == mask dims.
   - Letterbox regression: existing tests unchanged and passing; add one explicit check that
     `buildModnetInputTensor(..., Letterbox)` equals the result without the new parameter.
   - `modnetInputGeometryFor`: (false, nullptr)->Letterbox, (false,"0")->Letterbox, (true,nullptr)->Fill,
     (true,"0")->Fill, (true,"")->Fill, (true,"1")->Letterbox.

## Acceptance criteria
1. Windows default: the tensor is the whole frame stretched to N x N (no padding pixels); tensor shapes,
   tier sizes, prebuilt sessions and probes are unchanged.
2. The emitted `AlphaMask` has exactly the same width/height as before for every source/tier combination.
3. `BROADIFY_MEETING_KEYER_LETTERBOX=1` restores byte-identical pre-change behavior (tensor and mask).
4. Non-Windows builds behave byte-identically to before (geometry Letterbox).
5. CPU, fp16, zero-copy (incl. its parity reference) and OpenVINO paths use the same mapping per frame.
6. New tests above exist and pass; all existing ctest targets still pass on macOS
   (`npm run build:meeting-helper && npm run test:meeting-helper-native`).
7. Only these files change: matting_common.h/.cpp, modnet_keyer.cpp, openvino_keyer.cpp, dml_device_input.cpp/.h
   (comments only unless a change is required), tests/matting_common_test.cpp, the doc file(s), TASK.md.
   No changes to frame_pipeline, governor, session building, webapp or macOS CoreML code.

## Constraints
- English code comments, existing naming/style, no reformatting of untouched code.
- Do not commit; leave changes in the working tree.
- If anything in the code contradicts this plan, stop and write the contradiction into the Review section
  instead of guessing.

## Review
- Round: 0/3
- Verdict: (pending)
- Must-fix (open):
- Notes (non-blocking):
  - Implementer report (round 0, 2026-10-17). Files and functions changed:
    - `src/keyer/matting_common.h/.cpp`: new `enum class ModnetInputGeometry { Letterbox, Fill }`;
      `ModnetLetterboxMapping` gains `geometry` (default Letterbox), `maskOutputWidth/Height`;
      `modnetLetterboxMapping` now also sets `maskOutputWidth/Height = contentWidth/Height` (nothing else changed);
      new `modnetFillMapping`, `modnetInputMapping`, `modnetInputGeometryFor`, `modnetInputGeometryForThisPlatform`
      (function-local static, reads `BROADIFY_MEETING_KEYER_LETTERBOX` once, `isWindows = defined(_WIN32)`);
      `buildModnetInputTensor` gets trailing `ModnetInputGeometry geometry = Letterbox` and builds the mapping via
      `modnetInputMapping` (loop untouched); `copyModnetAlphaMask` gets a Fill branch (after the unchanged early
      returns) that calls the new anonymous-namespace `copyFilledModnetAlphaMask` (identity copy when
      maskOutput == mask dims, otherwise separable bilinear via `bilinearTaps`, OpenCV INTER_LINEAR centre
      alignment, clamp of the interpolated value to [0,1], `round(alpha * 255.0f)`); the Letterbox crop code is
      untouched.
    - `src/keyer/modnet_keyer.cpp` `Impl::apply()`: one `const ModnetInputGeometry inputGeometry =
      modnetInputGeometryForThisPlatform()` per frame, passed to all 4 tensor builds (zero-copy mapping via
      `modnetInputMapping`, parity reference, CPU/fp16 build, post-binding-failure rebuild); `copyModnetAlphaMask`
      still receives `letterbox` (= the mapping that built the tensor). `Impl::ensureLoaded()` (non-Apple branch,
      after `modelDynamic_`): once-per-process `input_geometry` stdout line. No session/tier/probe/prebuild change.
    - `src/keyer/openvino_keyer.cpp`: `apply()` passes `modnetInputGeometryForThisPlatform()` to
      `buildModnetInputTensor`; `ensureLoaded()` emits the same once-per-process `input_geometry` line.
    - `src/keyer/dml_device_input.h/.cpp`: comments only (shader/validation unchanged; `buildDeviceTensor`
      accepts the Fill mapping because `inputWidth/Height` stay the tier size).
    - `tests/matting_common_test.cpp`: new blocks for letterbox maskOutput, Fill mapping 512/320/256 + zero dims,
      Fill tensor on an 8x4 block frame (4x4), explicit-Letterbox byte-identity (memcmp), Fill readback 4x4->4x2
      hand-computed (incl. clamp after interpolation), Fill readback 4->3 fractional weights, Fill identity copy,
      Fill early returns, `modnetInputGeometryFor` 6 cases + platform selector consistency.
    - `docs/bridge/features/meeting-keyer-windows.md`: pipeline, env table, new "Input Geometry" section with the
      measured numbers and source path, Field A/B row, log line. `meeting-keyer-rendering-dataflow.md` unchanged
      (it does not describe the Windows letterbox).
  - Deviations / interpretation choices: (1) the `input_geometry` line is emitted once per process per backend
    (ModnetKeyer and OpenVinoKeyer each have their own static), so a process that loads both prints it twice;
    (2) in the Fill readback the clamp to [0,1] is applied to the interpolated value (test pins this);
    (3) Fill readback emits `maskOutputWidth x maskOutputHeight` literally as specified; this equals the letterbox
    crop size whenever the model output dims equal the input dims (always true for MODNet, would differ only for
    a model whose output resolution differs from its input).
  - Extra checks run (scratchpad, not part of the repo): strict `-Wall -Wextra -Wpedantic -Wshadow -Wconversion
    -Wsign-conversion` compile of matting_common.cpp + test: 0 warnings; Windows selector simulated by compiling
    copies with `#if defined(_WIN32)` -> `#if 1`: env unset -> fill, `1` -> letterbox, `0`/empty/`true` -> fill, test
    passes in all; 5 mutations (no Fill readback, Fill tensor = letterbox, clamp before interpolation, nearest
    instead of bilinear, any non-empty env value) each turn the test red; micro-benchmark 1920x1080 on this Mac:
    mask sizes identical per tier (512x288/320x180/256x144), tensor build ~1.1-1.8 ms either geometry, Fill
    readback ~0.05-0.2 ms vs ~0.02-0.1 ms crop.
  - Final ctest summary line (macOS, `npm run build:meeting-helper && npm run test:meeting-helper-native`):
    `100% tests passed, 0 tests failed out of 37`.
  - Not compiled/tested on macOS: everything under `BROADIFY_ENABLE_MODNET` in modnet_keyer.cpp (apply()/ensureLoaded()
    edits), all of openvino_keyer.cpp (empty TU without `BROADIFY_ENABLE_OPENVINO && _WIN32`) and
    dml_device_input.h/.cpp (comment-only edits). Needs the Windows CI run (test-release workflow).
  - (Superseded by the follow-up below: both docs are now updated.)
  - Follow-up after coordinator decision "option (b), Fill only" (2026-10-17):
    - Change (smallest variant): in `buildModnetInputTensor` the four block bounds are no longer `const`, and only
      when `mapping.geometry == Fill` the new anonymous-namespace helper `clampFillBlockBounds(begin, end, extent)`
      applies the shader's rule before `writeIntegerBlockAverage` is called: `begin = min(begin, extent-1)`,
      `end = min(max(end, begin+1), extent)` (rows with `input.height`, columns with `input.width`).
      `writeIntegerBlockAverage` itself is untouched, so its empty-block grey early return still runs for Letterbox;
      for Fill the block can no longer be empty, and the clamps inside `writeIntegerBlockAverage` are idempotent
      after the caller's clamp (same formulas). I chose the caller-side adjustment over a flag parameter because it
      leaves `writeIntegerBlockAverage` and every Letterbox value byte-identical with no signature change.
      For downscaled Fill blocks (never empty) the result is unchanged versus the first round.
    - CPU vs GPU check (read `kBuildInputShader` in dml_device_input.cpp, shader not changed): the shader computes
      `left/top/right/bottom` with the same integer formulas from the mapping's content rect (Fill: 0,0,N,N), then
      `left=min(left,srcW-1)`, `top=min(top,srcH-1)`, `right=min(max(right,left+1),srcW)`,
      `bottom=min(max(bottom,top+1),srcH)`, sums the same pixels as uints and normalizes `(sum*scale-0.5)/0.5`.
      The CPU Fill path now uses identical bounds and identical integer sums; the only difference is float
      rounding of the normalization (CPU computes the scale in double, shader in float). Measured with a
      line-for-line C++ port of the shader (scratchpad, not a GPU run), Fill vs CPU for 1920x1080, 1280x720, 640x480,
      640x360, 848x480, 320x240, 424x240, 1080x1920 at 512/320/256: max |diff| <= 1.8e-7 in every case, 0 elements
      over the 1e-2 parity tolerance (640x480 -> 512 included). Letterbox still diverges only for tiny sources
      (320x240 @512, 424x240 @512: CPU grey vs shader nearest pixel) - unchanged by design; the parity gate disables
      zero-copy there as before.
    - Letterbox byte-identity vs. dev HEAD: a dump program compiled once against the unmodified
      `git show HEAD:` matting_common.h/.cpp and once against the new files (default-parameter calls, 12 sources incl.
      0x0, 1x1, 2x1, 6x3, 320x240, 640x480, 1920x1080, 1080x1920; N = 512/320/256/4; tensor + mapping + emitted mask)
      produced identical 64,895,464-byte outputs (`cmp` equal).
    - Grey scan after the change: Fill has 0 mid-grey elements inside the content for all sources above at all tiers;
      Letterbox counts unchanged (320x240 @512: 119808, 424x240 @512: 46720).
    - New tests in matting_common_test.cpp: Fill 4x2 -> 4x4 (tensor rows read source rows 0,0,1,1, hand-computed,
      no padding value); Fill 640x480 -> 512 uniform frame (every element = normalized pixel, no grey rows);
      Letterbox 2x1 -> 4x4 tiny source keeps the grey early return (content 4x2 at row 1: row 1 all 0.0, row 2 =
      grey, p0, grey, p1) with the same frame under Fill reading p0,p0,p1,p1; the 2x1 frame is added to the
      explicit-Letterbox byte-identity list. Mutations: dropping the Fill clamp fails 4 assertions, applying it to
      Letterbox too fails the tiny-Letterbox assertion. Strict-warning compile: 0 warnings.
    - Docs: meeting-keyer-windows.md limitation bullet replaced with the new Fill behavior;
      meeting-windows-performance.md zero-copy bullet now describes both mappings and the Letterbox tiny-source
      parity exception; meeting-helper-dev-setup.md env table lists `BROADIFY_MEETING_KEYER_LETTERBOX=1`.
      dml_device_input.cpp shader comment extended (comment only) with the Fill/Letterbox parity statement.
    - Note: `BROADIFY_MEETING_KEYER_LETTERBOX` is not in `MEETING_HELPER_FORWARDED_ENV_KEYS`
      (apps/bridge/src/services/meeting/meeting-helper-manager.ts, outside the allowed files). Not needed: the
      Windows helper is spawned with the full `process.env`, and non-Windows builds ignore the variable. The
      dev-setup sentence "macOS bundle forwards only the documented variables" is therefore slightly broader than
      reality for this one row (harmless).
    - Final ctest summary line after the follow-up: `100% tests passed, 0 tests failed out of 37`.
  - Verifier non-blocking notes applied (2026-10-17, after package A PASS):
    1. Kill-switch wording corrected: the Desktop app reads `.env` once at app start (`loadAppEnv` in
       src/electron/services/env-loader.ts, called from src/electron/util.ts, guarded by `envLoaded`), so the docs
       now say "after restarting Broadify Bridge (the `.env` is read at app start)". Changed in
       meeting-keyer-windows.md (Input Geometry bullet + Field A/B row) and meeting-helper-dev-setup.md (env row).
       The only "helper restart" wording was in meeting-keyer-windows.md; TASK.md had none of my own (the plan
       text in "## Plan" is left as written).
    2. meeting-keyer-windows.md: the first table is labelled as the Python emulation (BEFUND.md source); added the
       verifier's real-code table (C++ matting_common.cpp + ft-v7d ONNX, lab frames 768x432, 60 + 60 frames,
       768x432 and upscaled-to-1080p columns) and the known limitation (sources with fewer rows than the tier, e.g.
       768x432 / 640x480 / 848x480 at 512, use nearest-row duplication for CPU/GPU parity and are about +0.2 points
       worse at 512; 1080p/720p unaffected).
    3. `keyer_input_geometry` event: modnet_keyer.cpp and openvino_keyer.cpp include `util/helper_event_log.h` and,
       inside the existing once-per-process static (same place as the stdout line, which is kept unchanged), call
       `emitHelperEvent("{\"type\":\"keyer_input_geometry\",\"geometry\":\"fill|letterbox\",\"backend\":\"modnet|openvino\"}")`.
       Note: `emitHelperEvent` itself also writes the line to stdout, so stdout now carries both lines.
       Link check (CMakeLists.txt): `src/util/helper_event_log.cpp` is in the unconditional
       `MEETING_HELPER_SOURCES`, so the `meeting-helper` target links on all platforms. The only other target
       compiling these files is `matting_backend_test` (no helper_event_log.cpp), but it builds without
       `BROADIFY_ENABLE_MODNET`/`BROADIFY_ENABLE_OPENVINO`, so both calls are preprocessed out there (modnet call sits
       inside `#if BROADIFY_ENABLE_MODNET`, openvino_keyer.cpp is an empty TU); it built and linked on macOS.
       Because both call sites are not compiled on macOS, I extracted the exact lambda text from both files into a
       scratch harness and compiled it with -Wall -Wextra -Wpedantic against matting_common.cpp and
       helper_event_log.cpp: 0 warnings; output once per process per backend, events file contains
       `{"type":"keyer_input_geometry","geometry":"letterbox","backend":"modnet"}` and the openvino line (macOS
       selector -> letterbox; Windows -> fill). Docs: Field A/B row points to `keyer_input_geometry` in
       `%APPDATA%\Broadify Bridge RC\meeting-helper-events.log` (path verified: bridge `userDataDir` = Electron
       `app.getPath("userData")`, file `meeting-helper-events.log`, rewritten per helper start).
    4. New test: portrait 1080x1920 at 512 -> letterbox content 288x512, Fill maskOutput 288x512, and
       `copyModnetAlphaMask` emits 288x512 (left/right halves preserved). Mutation "maskOutputWidth = inputWidth"
       is caught only by this portrait test (2 assertions).
    5. Final run: `npm run build:meeting-helper` OK; `100% tests passed, 0 tests failed out of 37`.
- Handoff to human (if any):
  - RESOLVED 2026-10-17 (coordinator chose option (b), implemented as described in the follow-up note above).
    Original item, kept for the record - CONTRADICTION (plan vs. code) for camera frames smaller than the tier size N in a dimension. The plan says
    "the integer block-average loop already maps x and y independently, so Fill needs no new sampling code" and
    AC1 says "no padding pixels". That holds for 1920x1080 and 1280x720 at 512/320/256 (verified: 0 mid-grey
    elements). But when the source extent is smaller than the content extent (upscale), `writeIntegerBlockAverage`
    gets empty blocks (`right <= left`) and writes normalized mid-grey (0.0) - existing code, matting_common.cpp
    `writeIntegerBlockAverage` early return. Letterbox only upscales when the source is smaller than the content
    rect (e.g. 320x240 @512); Fill stretches the height to N, so it upscales whenever source height < N. Measured on
    the implemented code: 640x480 @512 fill -> 32 full mid-grey rows (letterbox: 0); 640x360 @512 -> 152 (letterbox: 0);
    848x480 @512 -> 32 (letterbox: 0); 320x240/424x240 also @320/@256. The D3D12 zero-copy shader handles empty
    blocks differently (`right = max(right, left + 1)` samples one pixel), so for such sources the opt-in zero-copy
    parity gate would fail and disable zero-copy (fail-safe, pre-existing for tiny letterbox sources).
    Not fixed (would be new sampling behaviour outside the plan). Whether Windows ever delivers sources below
    512 px height depends on the camera (MediaFoundation ranking prefers the requested size, but can pick e.g.
    640x480 when larger modes are below 15 fps). Options for the human: (a) accept (document only - done in
    meeting-keyer-windows.md "Limitation"); (b) in Fill only, treat an empty block as its nearest source pixel
    (CPU then matches the shader's clamp exactly); (c) fall back to Letterbox per frame when source width or height
    < N. Recommended default: (b), as a small follow-up with its own test, because it also makes CPU and GPU agree.

## Verification
- [ ] Tests pass (macOS ctest)
- [ ] Windows compile + native tests pass (test-release workflow on this branch)
- [ ] Bug reproduced before the fix, gone after (offline measurement: win_fressen.py letterbox vs stretch)

## Verifier (independent, not the implementer)
- Round 1: PASS, no must-fix. Scope ok; Letterbox byte-identical to origin/dev (19 sources x 5 sizes, sha1 equal);
  CPU Fill vs ported GPU shader max diff 1.8e-7; emitted mask dims identical in 38,526 combinations.
  Real-code end-to-end (C++ matting_common + ft-v7d ONNX, eaten %, clean / webcam):
  320: 3.70/5.89 -> 2.76/3.79; 256: 8.84/11.17 -> 3.83/5.31; 512 equal or better for 1080p/720p sources,
  about +0.2 points for sources with fewer than 512 rows (documented limitation).
- Notes applied afterwards (docs wording, emulation label + real-code table, keyer_input_geometry events-log line,
  portrait test). Orchestrator re-ran: `npm run build:meeting-helper` exit 0; ctest "100% tests passed, 0 tests failed out of 37".
- Open before merge: Windows CI compile + native tests (test-release workflow on this branch).
