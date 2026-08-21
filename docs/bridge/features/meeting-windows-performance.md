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

Der Helper loggt einmal `gpu_adapter_selected` mit Beschreibung und LUID.
`keyer.get`/`state.get` enthalten `gpu_adapter` und `compositor_adapter`.
Fuer Akzeptanz muessen beide Felder dieselbe LUID zeigen, wenn DirectML und
D3D11 aktiv sind.

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

## Latenzpolitik

Der Windows-Keyer-Governor steigt ab, sobald die geglaettete Inferenzzeit
mehr als 0,5 x Framebudget verbraucht (bei 30 fps ca. 16,7 ms). Step-up bleibt
unveraendert konservativ. `BROADIFY_MEETING_FUSED_PIPELINE_DEPTH=0` ist heute
ein Kill-Switch fuer die fused cadence reuse: bei `0` laeuft Inferenz fuer
jeden neuen Kamera-Frame und `mask_age_ms` wird auf 0 gesetzt; Default `1`
erlaubt die Wiederverwendung der retained matte zwischen Inferenz-Frames und
refined sie erneut gegen den aktuellen Kamera-Frame. Die geplante ein-Frame
Software-Pipeline (Inference N parallel zu Composite N-1) ist auf WP3
verschoben.

Zeitbasierte Hintergruende werden nur auf Kamera-, Programm- oder
Grafik-Aenderungen fortgeschrieben; ohne solche Aenderung gibt es keinen
separaten Render-Tick.

BFRG v2 traegt `capture_ns`; die VCam-DLL akzeptiert v1 und v2. Samples werden
aus dem Produzentenzeitstempel erzeugt, duplizierte Frames laufen mit
Frame-Dauer weiter.

## Messen

1. In Windows Task Manager die Spalten fuer GPU Engine/GPU-Auslastung oeffnen.
   Bei Hybrid-Geraeten pruefen, ob DirectML und D3D11 dieselbe GPU/LUID nutzen.
2. In `keyer.get` `gpu_adapter`, `compositor_adapter`,
   `keyer_pipeline_mode`, `active_performance_mode`, `metrics.session_run_ms`
   und `metrics.program_frame_ms` beobachten.
3. VCam-Verbrauch nur messen, wenn eine App wirklich streamt; eine bloss
   registrierte/armierte Kamera verbindet die DLL nicht dauerhaft.
