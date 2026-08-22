# Meeting Windows Stage B Design

Status: WP4 implemented in `feature/win-stability-wp4`.

## 1. Scope

Stage B hardens the Windows meeting path: fused rendering, output lifecycle,
virtual camera stability, and support diagnostics. macOS keeps its existing
CMIO extension and TCP transport.

## 2. Boundaries

- Renderer/FrameBus remains the graphics data plane.
- Meeting Helper owns local camera/keyer/compositor work.
- Windows VCam DLL runs inside the Windows Frame Server as LOCAL SERVICE.
- Control remains IPC/RPC; frame transport for Windows VCam is SHM by default.

## 3. Windows Virtual Camera SHM Transport

WP4 replaces the default Windows VCam TCP frame path with a named shared-memory
ring:

- Helper creates `Global\BroadifyVcamControl` and a per-run
  `Global\BroadifyVcam-<pid>-<tick>` stream mapping when
  `output.vcam.raw.start` arms the output.
- ACL SDDL grants owner and Administrators full access, and
  `NT AUTHORITY\LOCAL SERVICE` read/synchronize access so the Frame Server can
  open the mapping.
- Ring layout is `BFSM` version 1, three BGRA8 slots, seqlock sequence per
  slot, capture QPC, writer generation, heartbeat QPC, and reader count.
- DLL activation never probes TCP or sleeps. It reads geometry from the control
  mapping if present, otherwise advertises 1920x1080@30 immediately.
- DLL streaming opens SHM on `MediaStream::Start`; TCP connects only when SHM
  is absent/unreadable or heartbeat is stale, then periodically retries SHM.
- Media types advertise NV12 first, then RGB32 and YUY2. WP4 helper writes
  BGRA8; the DLL converts to NV12/YUY2 as needed.
- `BROADIFY_MEETING_VCAM_TRANSPORT=tcp` restores the previous TCP path for one
  release. `output.vcam.status.transport` and
  `meeting_vcam_raw/vcam_transport_selected` report the selected transport.

macOS cannot compile the Windows Frame Server DLL, SDDL ACL path, or
MediaFoundation buffers. Platform-neutral layout, seqlock, discovery, SDDL
string, and BGRA-to-NV12 conversion are covered by ctests on macOS; Windows CI
must compile the DLL and run the SHM self-test.

## 4. Windows Temporal Segmentation Tiers

WP5 adds an explicit Windows-only segmentation tier decision before the keyer
session starts:

- `os_mask` (T0): intended for Windows Studio Effects background-segmentation
  masks when the capture source exposes the mask capability.
- `modnet_512_ofd` (T2): default MODNet tier with one-frame-delay temporal
  stabilization.
- `modnet_320_ofd`: lower fixed MODNet input tier after sustained budget
  pressure.
- `selfie_landscape` (T3): optional MediaPipe Selfie Segmenter landscape ONNX
  backend for iGPU-only machines where MODNet 320 is over budget. RVM is not
  included because of its GPL-3.0 license.

The selected tier is logged as `segmentation_tier_selected` and reported in
`keyer.get.status.keyer_tier`. `keyer_tier_reason` explains why the tier was
chosen or why a requested tier was unavailable. The bridge persists helper
`keyer_tier_cache` events to `<userData>/keyer-tier.json` for field triage.

MODNet OFD is the primary flicker fix on Windows. It emits mask `t-1` after
seeing masks `t-2`, `t-1`, and `t`, replacing isolated one-frame alpha spikes
while preserving sustained motion. Windows fused EMA defaults to off
(`BROADIFY_MEETING_FUSED_EMA_STATIC=1.0`) to avoid double temporal smoothing.

The fused governor no longer changes input size per frame. It may use cadence
pinning/unpinning, and it only drops from fused 256 to async lite after a
continuous 30-second over-budget window; step-up hysteresis is 60 seconds.

`meeting-helper --keyer-tier-selftest --models-dir <dir>` prints the probe
summary expected in CI. On common CI runners without Windows Studio Effects
mask support, the expected tier is T2 (`modnet_512_ofd`).
