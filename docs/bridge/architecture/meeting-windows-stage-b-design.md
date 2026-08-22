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

WP4b uses a service-owned named shared-memory ring for the default Windows
VCam frame path:

- The DLL creates `Global\BroadifyVcam-control`,
  `Global\BroadifyVcam-stream`, and `Global\BroadifyVcam-frame` when
  `MediaStream::Start` activates the stream.
- ACL SDDL grants `LOCAL SERVICE` full access and grants Interactive Users
  plus Authenticated Users read/write.
- Ring layout is `BFSM` version 2, three BGRA8 slots, seqlock sequence per
  slot, owner, capacity bytes, capture QPC, writer generation, heartbeat QPC,
  and reader count.
- DLL activation never probes TCP or sleeps. It reads geometry from the control
  mapping if present, otherwise advertises 1920x1080@30 immediately.
- DLL streaming opens SHM on `MediaStream::Start`; TCP connects only when SHM
  is absent/unreadable or heartbeat is stale, then periodically retries SHM.
- Media types advertise NV12 first, then RGB32 and YUY2. WP4 helper writes
  BGRA8; the DLL converts to NV12/YUY2 as needed.
- `BROADIFY_MEETING_VCAM_TRANSPORT=tcp` restores the previous TCP path for one
  release. `output.vcam.status.transport` and
  `meeting_vcam_raw/vcam_transport_selected` report the selected transport.

### WP4b service-owned ring

WP4b flips SHM ownership to the Windows Frame Server process. On
`MediaStream::Start`, the DLL creates `Global\BroadifyVcam-control`,
`Global\BroadifyVcam-stream`, and `Global\BroadifyVcam-frame` at the maximum
supported capacity (`1920x1080 BGRA * 3 slots`). The initial headers are
zero-geometry with `owner=service`, `writer_generation=0`, and
`capacity_bytes` set; the helper validates those fields before writing
geometry and bumping generation.

The DACL grants `LOCAL SERVICE` full access and grants Interactive Users plus
Authenticated Users read/write. This matches the local trust level of the TCP
loopback fallback: any local authenticated user can write frames and control
fields, but no secrets are present. The consequence is deliberate defensive
parsing: object names are copied with fixed bounds, stream mappings are opened
read-only by the DLL reader, and every header-derived size, stride, slot count
and payload length is revalidated before a memcpy.

Helper `output.vcam.raw.start` now attempts `OpenFileMappingW` first
(`opened_service_ring`), then attempts the fixed `Global\` creator fallback
when elevated (`created_global`). It no longer creates `Local\` mappings for
runtime because they do not cross the desktop/session boundary. If the service
ring is absent, TCP remains active and the helper retries every 2 s while raw
output is armed. If a previously visible DLL reader heartbeat disappears for
more than 5 s, the helper closes its stale handles and re-runs the open path.
The raw RPC handlers only arm or disarm output; the lifecycle thread is the
sole owner of open/retry/close. The named section stays alive while either the
DLL or helper holds a handle, and each helper publish path writes geometry plus
a bumped writer generation so DLL readers can detect restarts and reopen.

macOS cannot compile the Windows Frame Server DLL, SDDL ACL path, or
MediaFoundation buffers. Platform-neutral layout, seqlock, discovery, SDDL
string, retry sequencing, and BGRA-to-NV12 conversion are covered by ctests on
macOS; Windows CI must compile the DLL and run the SHM self-test plus
`vcam_shm_service_ring_test`.
