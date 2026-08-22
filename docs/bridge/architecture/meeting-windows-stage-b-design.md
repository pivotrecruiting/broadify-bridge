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
