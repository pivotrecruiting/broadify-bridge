# TASK — ATEM-USB Windows helper: real HRESULT diagnostics + self-describing build (SDK ≥ 9.7)

Scope: ONLY `apps/bridge/native/atem-usb-helper/` (src/atem-usb-helper.cpp, build.ps1, build.sh, README/DEPLOY docs). No bridge TS
changes, no other helpers, no schema changes. Round: 0/3.

Field evidence (25.08.2026, Windows 11, ATEM Mini Extreme): shipped prebuilt `atem-usb-helper.exe` reports
`atem_software_not_installed` although ATEM Switchers 9.7 (and previously 10.0) is installed, DLL present and COM-registered.
Byte-scan proved the 9.x Discovery IID (83C30ED4-4314-4C81-B1E3-23C518D6D8BD) is NOT embedded in the shipped exe → the asset was
built against a wrong/unknown SDK. Contributing factor: build.ps1's default SDK path is
`…\Blackmagic Design\Blackmagic ATEM Switchers\Developer SDK\Windows` while the real 9.7 install uses
`…\Blackmagic Design\ATEM Switchers\…`. The mac helper (built from the local SDK at package time) works.

## A1 — Windows HRESULT diagnostics (src/atem-usb-helper.cpp)
- `createSwitcherDiscovery()` (Windows branch, ~:119-128): capture the HRESULT of `CoCreateInstance` into a file-scope
  `std::atomic<long> g_lastDiscoveryHr` (or plain long guarded appropriately; single-threaded use at startup is fine). On failure
  return nullptr as today.
- `--probe` JSON: add fields `"discovery_hr":"0x8004…"` (hex, 0x0 on success) and the build-info fields from A2. Keep every existing
  field unchanged.
- Error events / probe error for missing SDK: append the hex HRESULT to the existing `atem_software_not_installed` message detail
  (e.g. `… (CoCreateInstance hr=0x80040154)`); the error CODE string stays exactly `atem_software_not_installed` (bridge maps on it).
- No behaviour change on macOS (all new code `#if defined(_WIN32)` except the build-info fields, which exist on both platforms).

## A2 — Self-describing build
- build.ps1: extract from the chosen IDL (a) SHA256 (first 12 hex chars), (b) the uuid of `coclass CBMDSwitcherDiscovery` (regex over
  the idl text: the `uuid(...)` attribute immediately preceding `coclass CBMDSwitcherDiscovery`), and (c) an SDK version string if the
  idl contains one (else "unknown"). Pass them via `/DHELPER_SDK_IDL_SHA="…" /DHELPER_SDK_DISCOVERY_CLSID="…" /DHELPER_SDK_VERSION="…"`.
- build.sh (macOS): same three defines derived from the local `BMDSwitcherAPI.h` (SHA over the header; CLSID "n/a-macos"; version
  best-effort from the header comment else "unknown").
- Helper: `--probe` JSON and the `ready` event gain `"helper_build": {"sdk_idl_sha":"…","sdk_discovery_clsid":"…","sdk_version":"…"}`.
  Defaults ("unbuilt") if the defines are absent so local dev builds still compile.

## A3 — build.ps1 robustness (≥ 9.7 reality)
- SDK path resolution order: `ATEM_SDK_ROOT` env → `C:\Program Files (x86)\Blackmagic Design\ATEM Switchers\Developer SDK\Windows`
  → `C:\Program Files (x86)\Blackmagic Design\Blackmagic ATEM Switchers\Developer SDK\Windows`. Print the resolved idl path, its
  SHA256 and the extracted Discovery CLSID before compiling. Fail with a clear message listing all tried paths.
- After the build: run `atem-usb-helper.exe --probe` is NOT possible headless on CI, but add a static self-check: scan the built exe
  for the 16-byte little-endian pattern of the extracted Discovery CLSID and of IID 83C30ED4-4314-4C81-B1E3-23C518D6D8BD
  (only when the idl's IID matches that value); fail the build if the CLSID bytes are absent. (PowerShell byte scan; keep it < 30 lines.)
- DEPLOY.md: document the corrected paths, the self-check, and that the shipped asset MUST be rebuilt whenever Blackmagic changes GUIDs
  (major versions); note the 24.08. incident.

## Verification (macOS host)
- `bash apps/bridge/native/atem-usb-helper/build.sh` compiles (mac SDK present on this machine) and `./atem-usb-helper --probe`
  still returns valid JSON incl. the new `helper_build` fields (ATEM may or may not be connected; both fine).
- `npm run lint` and `npx jest --silent` untouched/green (no TS changes expected — confirm no accidental edits outside the helper dir).
- Windows compile/verify happens on the field laptop afterwards (build instructions separate).

## Acceptance
- Diff touches ONLY files under `apps/bridge/native/atem-usb-helper/`.
- Error code strings unchanged; JSON strictly additive.
- macOS helper behaviour unchanged apart from additive JSON fields.

## Round 2 — dual-generation Windows build without SDK (Go 25.08.)
Field facts: shipped exe contains neither 9.x nor 10.x Discovery GUIDs; customer PC (Win11) had 10.0 then 9.7 — both failed. IDL diff
9.7 vs 10.0 (reference extracts in `.atem-idl-ref/idl97.txt` / `idl100.txt` at the worktree root, UNTRACKED — read them, never commit):
- Discovery IID: 9.7 = 83C30ED4-4314-4C81-B1E3-23C518D6D8BD; 10.0 = 1EEE089A-5422-4A76-B068-F6EDCFBD3AC0.
- Discovery coclass CLSID: 9.7 = B8C0BA7E-BDED-4B73-96A8-266AF1BC2D7A; 10.0 = 8A13D4FA-4801-48E3-BF68-442D63E34500.
- IBMDSwitcher IID differs (5054C164-… vs FD979282-…) but 10.0 only APPENDS `DoesSupportTallyConfig` at the vtable end —
  prefix-compatible; we never QI for IBMDSwitcher (ConnectTo returns it directly) and never call the appended method.
- IBMDSwitcherCallback, MacroPool(+Callback), MacroControl(+Callback), TransferMacro and the four enums are identical in both IDLs.

### B1 — Interop header `src/bmd_switcher_interop_win.h` (Windows only)
Hand-written interoperability declarations (own authorship; header comment: minimal Blackmagic Switcher COM surface for
interoperability, GUID values from the vendor IDLs, no vendor text copied). Declare with EXACT method order from `idl97.txt`:
IBMDSwitcherDiscovery, IBMDSwitcher (full 9.7 list; params of uncalled methods may use generic typedefs like `unsigned int` /
`long long`), IBMDSwitcherCallback, IBMDSwitcherMacroPool(+Callback), IBMDSwitcherMacroControl(+Callback), IBMDSwitcherTransferMacro —
all `: public IUnknown`, `virtual HRESULT STDMETHODCALLTYPE`. Methods the helper calls or overrides get exact real signatures (BSTR on
Windows). Enums used, with exact values from the ref file. GUIDs: `CLSID_CBMDSwitcherDiscovery_v97/_v100`,
`IID_IBMDSwitcherDiscovery_v97/_v100`, single IIDs for identical interfaces. No midl, no `_i.c`.

### B2 — src/atem-usb-helper.cpp (Windows branch)
Include the interop header instead of `BMDSwitcherAPI_h.h`. `createSwitcherDiscovery()`: try (CLSID_v97, IID_v97) then
(CLSID_v100, IID_v100); remember generation + both HRESULTs. Probe/ready JSON adds `"sdk_generation":"9"|"10"|"none"` and on failure
`"discovery_hr_v97"`/`"discovery_hr_v100"` (keep `discovery_hr` = v97 for continuity). Macro logic/callbacks unchanged.

### B3 — build.ps1
Default: build from the interop header, NO SDK required (no midl). Optional `-UseSdkIdl` switch restores the midl path for cross-checks.
Self-check: built exe must contain the byte patterns of BOTH Discovery CLSIDs and BOTH IIDs; fail otherwise. helper_build defines:
sdk_idl_sha "interop-v97+v100", sdk_version "9.7+10.0-interop".

### B4 — CI workflow `.github/workflows/atem-usb-helper-win.yml`
`workflow_dispatch` only; windows-2022; `ilammy/msvc-dev-cmd@v1` (x64); run build.ps1; upload `atem-usb-helper.exe` + SHA256 as artifact.
No secrets.

### Verification (macOS host)
macOS build.sh + `--probe` unchanged; `npm run lint` green; diff limited to the helper dir + the new workflow file; `.atem-idl-ref/`
stays untracked.

## Round 3 — MUST-FIX MF-1 + third generation 10.4 (Go 25.08.)
Review round 2 verdict MUST-FIX. New ground truth: `.atem-idl-ref/idl104.txt` (SDK 10.4; current field version). Measured slots
(method index within IBMDSwitcher, 1-based): GetProductName = 1 in ALL gens; AddCallback/RemoveCallback = 43/44 (9.7), 44/45 (10.0,
DoesSupportTallyConfig inserted at 42), 50/51 (10.4, inserts at 27-29 and 45-48). Discovery GUIDs 10.4: IID
28449053-AC7A-49EB-ACD2-D1E0C57DC627, coclass CLSID A9CDC765-3787-409D-A1E5-29F4F034A599. Callback/MacroPool/MacroControl/
TransferMacro IIDs and bodies identical across 9.7/10.0/10.4; enums additive only (10.4 adds two EventType values — additive, keep 9.7 set).
- R3-1 (MF-1) Per-generation IBMDSwitcher layouts: `IBMDSwitcher_v97/_v100/_v104` structs with EXACT method order from the respective
  ref file. Discovery declared once with `ConnectTo(BSTR, void** switcherOut, BMDSwitcherConnectToFailure*)`; after connect, wrap the
  raw pointer in a small `SwitcherHandle { void* p; int gen; }` exposing exactly `getProductName`, `addCallback`, `removeCallback`
  (dispatch by gen via static_cast to the right struct). All other switcher usage must go through this handle; compile-time no direct
  IBMDSwitcher* remains.
- R3-2 Third generation: try creation order v104 → v100 → v97 (newest first); `sdk_generation` ∈ {"10.4","10.0","9.7","none"}; on
  total failure emit all three HRESULTs (`discovery_hr_v97/_v100/_v104`; keep `discovery_hr` = v97).
- R3-3 Unsupported-version detection: if all creations fail AND `C:\Program Files (x86)\Blackmagic Design\ATEM Switchers\BMDSwitcherAPI64.dll`
  exists → detail "ATEM software found but its version is not supported by this helper (supported: 9.7, 10.0, 10.4)"; error code string
  stays `atem_software_not_installed` (bridge contract unchanged).
- R3-4 build.ps1 self-check: all SIX Discovery GUID byte patterns (3 CLSIDs + 3 IIDs) must be embedded; helper_build sdk_version
  "9.7+10.0+10.4-interop".
- R3-5 Notes: ready-event `sdk_generation` only after connect (omit or "none" until then — document); v100/v104 HR sentinel = 1
  (S_FALSE-like "not attempted") instead of 0; `-UseSdkIdl` doc wording honest (provenance stamp, not vtable cross-check); fix
  `jsonEscape` \u padding to 4 hex digits (pre-existing bug, trivial).
- R3-6 DEPLOY.md: supported-generations table + exact recipe to add a future generation (extract GUIDs + slots from new IDL, extend
  header/table/self-check).
