# Windows Meeting Performance

Dieses Dokument beschreibt die WP1-Stellschrauben fuer Windows-Last und
Latenz im Meeting-Helper und den guarded WP3 GPU-resident Pfad.

## GPU-Adapter

Der Windows-GPU-Pfad waehlt einmal pro Helper-Prozess einen DXGI-Adapter und
verwendet dessen LUID fuer D3D11-Compositor/Guided-Filter und DirectML.
Konfiguration:

- `BROADIFY_MEETING_GPU_POLICY=auto` (Default): bevorzugt
  High-Performance, wenn vorhanden.
- `BROADIFY_MEETING_GPU_POLICY=high_performance`: erzwingt die schnelle GPU.
- `BROADIFY_MEETING_GPU_POLICY=minimum_power`: bevorzugt die sparsame GPU.
- `BROADIFY_MEETING_GPU_POLICY=split`: A/B-Modus wie rc.12; der
  D3D11-Compositor nutzt den Default-Adapter, DirectML nutzt
  High-Performance.

Der Helper loggt einmal `gpu_adapter_selected` mit Beschreibung und LUID.
`keyer.get`/`state.get` enthalten `gpu_adapter` und `compositor_adapter`.
Fuer Akzeptanz muessen beide Felder dieselbe LUID zeigen, wenn DirectML und
D3D11 aktiv sind. Bei `split` duerfen sie abweichen.

DirectML DML1 wird mit eigener D3D12-Device/Queue initialisiert; die Queue ist
`D3D12_COMMAND_LIST_TYPE_DIRECT`. DML2 und das Legacy-Device-0 bleiben
Fallbacks. WP3s GPU-resident Flag verwendet einen gemeinsamen `GpuContextWin`
fuer D3D11, D3D12 und DirectML, inklusive shared Fence.

## QoS und Timer

Windows-QoS ist default aktiv und per `BROADIFY_MEETING_WIN_QOS=0`
abschaltbar. Aktiviert werden:

- Prozess opt-out aus Execution-Speed- und Timer-Resolution-Throttling.
- `timeBeginPeriod(1)` nur in `live`/`keyer_live`, Ruecknahme beim Verlassen.
- `AvSetMmThreadCharacteristicsW(L"Capture")` fuer Program- und
  Raw-Frame-Sender-Threads.
- Raw-Frame-Sockets mit `TCP_NODELAY` und groesserem Sendepuffer.

## Work-Gating

Der FrameBus startet nicht mehr implizit; `framebus_running` ist default
`false` und wird durch `output.framebus.start` bzw.
`conference_display_start` gesetzt. Programmarbeit laeuft nur bei neuer
Kamera, Programm-/Grafik-Revision oder neuem Keyer-Pair. Fused-Keyer-Arbeit
laeuft nur bei einer neuen Kamera-Frame-Timestamp.

MJPEG wird nur fuer verbundene MJPEG-Clients encodiert. Ist gleichzeitig ein
VCam-Client verbunden, wird MJPEG auf 10 fps gedrosselt.

## Readback

Der Guided-Refine-Readback liest immer die Maske des aktuellen Kamera-Frames
zurueck. Dadurch wird die Kante nicht mit einer Maske aus Frame N-1 auf Frame
N composited.

Der finale D3D11-Compositor-Readback nutzt default den direkten blocking
Copy/Map-Pfad (rc.12-Latenz). Die Staging-Ring-Variante ist nur per
`BROADIFY_MEETING_STAGING_RING=1` aktiv. Wenn sie aktiv ist, meldet
`metrics.staging_readback_depth` die Ring-Tiefe, sonst `0`.

WP3 zaehlt `metrics.cpu_frame_copies_per_frame` aus echten CPU-Kopien. Ein
VCam-TCP-Consumer zaehlt bis WP4 als CPU-Consumer, weil die virtuelle Kamera
noch RGBA ueber TCP erwartet. Recorder, MJPEG Preview und FrameBus zaehlen
ebenfalls als CPU-Consumer.

## Latenzpolitik

Der Windows-Keyer-Governor steigt ab, sobald die geglaettete Inferenzzeit
mehr als 1,0 x Framebudget verbraucht (bei 30 fps ca. 33,3 ms). Step-up wird
aus dieser Step-down-Schwelle berechnet und kann die Hysterese-Band nicht
invertieren. `BROADIFY_MEETING_FUSED_PIPELINE_DEPTH=0` ist heute
ein Kill-Switch fuer die fused cadence reuse: bei `0` laeuft Inferenz fuer
jeden neuen Kamera-Frame und `mask_age_ms` wird auf 0 gesetzt; Default `1`
erlaubt die Wiederverwendung der retained matte zwischen Inferenz-Frames und
refined sie erneut gegen den aktuellen Kamera-Frame.

Zeitbasierte Hintergruende werden nur auf Kamera-, Programm- oder
Grafik-Aenderungen fortgeschrieben; ohne solche Aenderung gibt es keinen
separaten Render-Tick.

Der Windows-Program-Loop darf durch eine fruehe Kamera-CV-Wake frueher
aufwachen, rendert aber nie schneller als `1 / targetFps`. Eine 60-fps-Webcam
treibt den fused Pfad daher nicht mehr mit 60 Hz, wenn der Helper auf 30 fps
konfiguriert ist.

MediaFoundation bevorzugt einen angebotenen nativen Kamera-Typ mit maximal
30 fps und maximal 1920x1080. Die Subtype-Praeferenz im rc.21 CPU-Pfad ist
NV12, YUY2, MJPG; danach wird weiter RGB32 fuer den Helper ausgegeben. Im WP3
DXGI-Pfad werden nur NV12 und YUY2 angefragt, nie MJPG, weil die GPU stages
direkt aus diesen YUV-Texturen lesen. Der ausgewaehlte native Typ wird als
`camera_native_media_type_selected` geloggt.

BFRG v2 traegt `capture_ns`; die VCam-DLL akzeptiert v1 und v2. Samples werden
aus dem Produzentenzeitstempel erzeugt, duplizierte Frames laufen mit
Frame-Dauer weiter.

## GPU-Resident WP3

`BROADIFY_MEETING_GPU_RESIDENT=1` aktiviert den Windows GPU-resident Pfad. Der
Default bleibt aus, damit rc.22 den rc.21 Pfad unveraendert A/B-testen kann.
Mit Flag aus bleiben Capture, Tensor-Build, Keyer und Compositor im bisherigen
Verhalten.

Wenn das Flag aktiv ist:

- Capture oeffnet den MediaFoundation Source Reader mit
  `IMFDXGIDeviceManager`, `MF_SOURCE_READER_D3D_MANAGER`,
  `MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING` und `MF_LOW_LATENCY`.
- DXGI-Capture liefert `GpuCameraFrame` mit `ID3D11Texture2D`, Subresource,
  Timestamp und MF-Subtype an den Program-Loop. Die MF Callback-Thread fuehrt
  keine D3D11-Fence-Operationen und keine CPU-Swizzles aus.
- Preprocess liest NV12/YUY2 per D3D11 SRV, fuehrt die gleiche Letterbox- und
  Box-Average-Logik wie `buildModnetInputTensor` aus und schreibt NCHW fp32 in
  einen D3D12-created shared buffer, der in D3D11 als UAV geoeffnet wird.
- DirectML IO binding nutzt `OrtDmlApi::CreateGPUAllocationFromD3DResource`
  fuer den shared Tensor Buffer. Fehlt die API oder scheitert eine Allocation,
  wird einmal `keyer_gpu_binding_unavailable` geloggt.
- `--gpu-selftest` erzwingt WARP, prueft den shared Fence per
  `SetEventOnCompletion`, dispatcht Preprocess auf einem synthetischen NV12
  Frame und rendert einen Compositor-Frame. Das Windows Smoke-Skript parst die
  JSON-Zeile und prueft gleiche D3D11/D3D12-LUIDs.

Telemetry:

- `gpu_resident` kommt ausschliesslich aus `GpuContextWin::telemetry().available`.
- `gpu_capture` ist `dxgi`, wenn ein DXGI-Frame der aktive Kamerapfad ist,
  sonst `cpu`.
- `keyer_io_binding` meldet nur echte ORT IO-binding Runs.
- `metrics.preprocess_ms`, `metrics.inference_ms`, `metrics.refine_ms` und
  `metrics.composite_ms` sind nur gesetzt, wenn der jeweilige GPU-Stage
  gemessen wurde; sonst `null`.

## Messen

1. In Windows Task Manager die Spalten fuer GPU Engine/GPU-Auslastung oeffnen.
   Bei Hybrid-Geraeten pruefen, ob DirectML und D3D11 dieselbe GPU/LUID nutzen.
2. In `keyer.get` `gpu_adapter`, `compositor_adapter`,
   `keyer_pipeline_mode`, `active_performance_mode`, `metrics.session_run_ms`,
   `metrics.program_frame_ms`, `gpu_resident`, `gpu_capture`,
   `keyer_io_binding` und `metrics.cpu_frame_copies_per_frame` beobachten.
3. VCam-Verbrauch nur messen, wenn eine App wirklich streamt; eine bloss
   registrierte/armierte Kamera verbindet die DLL nicht dauerhaft.
