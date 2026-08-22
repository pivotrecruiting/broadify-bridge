# Windows meeting performance

Status: WP3 implementation draft, 22.08.2026.

## GPU-resident flag

`BROADIFY_MEETING_GPU_RESIDENT=1` enables the Windows GPU-resident meeting path.
The default is off for rc.22 field A/B testing. With the flag off the helper
keeps the rc.21 capture, tensor, keyer and compositor paths.

Related diagnostics:

- `BROADIFY_MEETING_GPU_SELF_TEST_DRIVER=warp` makes `meeting-helper --gpu-selftest`
  create the shared context on WARP in CI.
- `BROADIFY_MEETING_GPU_POLICY` keeps the existing adapter policy. The
  gpu-resident path uses one adapter LUID for D3D11, D3D12 and DirectML.

## Fallbacks

- Camera capture tries an `IMFDXGIDeviceManager` Source Reader with NV12/YUY2
  when the flag is on. If the DXGI path cannot be opened, the helper logs
  `camera_gpu_capture_unavailable` and falls back to the RGB32 CPU reader.
- DirectML IO binding is guarded by a tested decision policy. If the provider
  API or resource allocation is unavailable, the helper logs
  `keyer_gpu_binding_unavailable` once and uses the existing CPU tensor input.
- Current WP3 keeps the RGBA compositor result for existing CPU consumers:
  recorder, MJPEG preview, FrameBus and TCP VCam. WP4 removes the TCP VCam
  readback by replacing it with shared memory NV12 transport.

## Telemetry

`state.get` and `keyer.get` report:

- `gpu_resident`
- `gpu_capture`
- `keyer_io_binding`
- `metrics.preprocess_ms`
- `metrics.inference_ms`
- `metrics.refine_ms`
- `metrics.composite_ms`
- `metrics.cpu_frame_copies_per_frame`

In WP3 on the existing TCP VCam transport, VCam is still counted as a CPU
consumer. A VCam-only zero-copy value of `0` requires the WP4 shared-memory
NV12 virtual camera transport.
