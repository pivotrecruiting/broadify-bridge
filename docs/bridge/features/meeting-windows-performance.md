# Windows Meeting Performance

Dieses Dokument beschreibt die WP1-Stellschrauben fuer Windows-Last und
Latenz im Meeting-Helper.

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

DirectML DML1 wird mit eigener D3D12-Device/Queue initialisiert. Default ist
`BROADIFY_MEETING_DML_QUEUE=compute`, also
`D3D12_COMMAND_LIST_TYPE_COMPUTE`; `direct` stellt fuer A/B wieder
`D3D12_COMMAND_LIST_TYPE_DIRECT` her. DML2 und das Legacy-Device-0 bleiben
Fallbacks.

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

## Latenzpolitik

Der Windows-Keyer-Governor steigt ab, sobald die geglaettete Inferenzzeit
mehr als 1,0 x Framebudget verbraucht (bei 30 fps ca. 33,3 ms). Step-up wird
aus dieser Step-down-Schwelle berechnet und kann die Hysterese-Band nicht
invertieren. `BROADIFY_MEETING_FUSED_PIPELINE_DEPTH=0` ist heute
ein Kill-Switch fuer die fused cadence reuse: bei `0` laeuft Inferenz fuer
jeden neuen Kamera-Frame und `mask_age_ms` wird auf 0 gesetzt; Default `1`
erlaubt die Wiederverwendung der retained matte zwischen Inferenz-Frames und
refined sie erneut gegen den aktuellen Kamera-Frame. Die geplante ein-Frame
Software-Pipeline (Inference N parallel zu Composite N-1) ist auf WP3
verschoben.

`Off` ist keine eingefrorene Maske mehr: der Status meldet
`keyer_pipeline_mode=off_reduced`, der Async-Keyer laeuft mit reduziertem
Takt weiter, und neue Masken werden per Live-Snap gegen das aktuelle
Kamera-Frame composited. `stale_hold` darf Luecken nur bis 2 s ueberbruecken;
danach faellt der Helper auf `background_only`/Passthrough zurueck.

Field-Regression rc.21 wird ueber `keyer.get` diskriminiert:
`keyer_pipeline_mode`, `degradation_stage`, `fallback_reason`, `provider` und
`gpu_adapter` zeigen, ob die Maschine in `off_reduced` haengt, ob DirectML
aktiv ist und welcher Adapter/Queue-A/B-Pfad laeuft.

Zeitbasierte Hintergruende werden nur auf Kamera-, Programm- oder
Grafik-Aenderungen fortgeschrieben; ohne solche Aenderung gibt es keinen
separaten Render-Tick.

Der Windows-Program-Loop darf durch eine fruehe Kamera-CV-Wake frueher
aufwachen, rendert aber nie schneller als `1 / targetFps`. Eine 60-fps-Webcam
treibt den fused Pfad daher nicht mehr mit 60 Hz, wenn der Helper auf 30 fps
konfiguriert ist.

MediaFoundation bevorzugt einen angebotenen nativen Kamera-Typ mit maximal
30 fps und maximal 1920x1080. Die Subtype-Praeferenz ist NV12, YUY2, MJPG;
danach wird weiter RGB32 fuer den Helper ausgegeben. Der ausgewaehlte native
Typ wird als `camera_native_media_type_selected` geloggt.

BFRG v2 traegt `capture_ns`; die VCam-DLL akzeptiert v1 und v2. Samples werden
aus dem Produzentenzeitstempel erzeugt, duplizierte Frames laufen mit
Frame-Dauer weiter.

## Messen

1. In Windows Task Manager die Spalten fuer GPU Engine/GPU-Auslastung oeffnen.
   Bei Hybrid-Geraeten pruefen, ob DirectML und D3D11 dieselbe GPU/LUID nutzen.
2. In `keyer.get` `gpu_adapter`, `compositor_adapter`,
   `keyer_pipeline_mode`, `degradation_stage`, `fallback_reason`, `provider`,
   `active_performance_mode`, `metrics.session_run_ms` und
   `metrics.program_frame_ms` beobachten.
3. VCam-Verbrauch nur messen, wenn eine App wirklich streamt; eine bloss
   registrierte/armierte Kamera verbindet die DLL nicht dauerhaft.
