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
- Raw-Frame-Sockets mit `TCP_NODELAY` und groesserem Sendepuffer, wenn der
  Windows-VCam-Transport auf TCP zurueckfaellt. Default ist SHM; bei gesunder
  SHM-Verbindung oeffnet die DLL keinen TCP-Client.

## Work-Gating

Der FrameBus startet nicht mehr implizit; `framebus_running` ist default
`false` und wird durch `output.framebus.start` bzw.
`conference_display_start` gesetzt. Programmarbeit laeuft nur bei neuer
Kamera, Programm-/Grafik-Revision oder neuem Keyer-Pair. Fused-Keyer-Arbeit
laeuft nur bei einer neuen Kamera-Frame-Timestamp.

MJPEG wird nur fuer verbundene MJPEG-Clients encodiert. Ist gleichzeitig ein
VCam-Client verbunden, wird MJPEG auf 10 fps gedrosselt.

Auf dem Windows-SHM-VCam-Pfad zaehlen SHM-Reader weiter als VCam-Consumer fuer
die Keyer-Policy. Das haelt die bisherige VCam-Kadenz unveraendert. Die
Preview-FrameStore-Kopie laeuft aber nur noch fuer MJPEG-Preview-Clients oder
TCP-Raw-VCam-Clients; reine SHM-Reader lesen aus dem SHM-Ring und brauchen
diese zusaetzliche RGBA-Kopie nicht.

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

Sobald ein Windows-VCam-Client verbunden ist, gilt eine strengere Policy:
fused cadence wird auf N=1 gepinnt, Dynamic-Dilation ist aus, und der Governor
steigt erst 512 -> 320 -> 256 ab. `async_lite` ist erst nach 30
aufeinanderfolgenden over-budget Samples bei fused 256 erreichbar. In
`async_lite`/`off_reduced` wird bei VCam das gepaarte Worker-Frame zur Maske
composited, nicht das neueste Live-Kamera-Frame; das akzeptiert bis zu 100 ms
Latenz, vermeidet aber Ghosting durch gealterte Masken.

`Off` ist keine eingefrorene Maske mehr: der Status meldet
`keyer_pipeline_mode=off_reduced`, der Async-Keyer laeuft mit reduziertem
Takt weiter. Ohne VCam werden neue Masken per Live-Snap gegen das aktuelle
Kamera-Frame composited; mit VCam wird die gepaarte Maske/Frame-Kombination
verwendet. `stale_hold` darf Luecken im normalen Betrieb nur bis 2 s
ueberbruecken; waehrend Warmup/Failure haelt der Helper `lastGoodMask` bis zu
5 s und meldet `keyer_ready=false` / `degradation_stage=keyer_loading`.

Field-Regression rc.21 wird ueber `keyer.get` diskriminiert:
`keyer_pipeline_mode`, `degradation_stage`, `fallback_reason`, `provider` und
`gpu_adapter` zeigen, ob die Maschine in `off_reduced` haengt, ob DirectML
aktiv ist und welcher Adapter/Queue-A/B-Pfad laeuft.

Zeitbasierte Hintergruende werden nur auf Kamera-, Programm- oder
Grafik-Aenderungen fortgeschrieben; ohne solche Aenderung gibt es keinen
separaten Render-Tick.

Der Windows-Program-Loop darf durch eine fruehe Kamera-CV-Wake frueher
aufwachen, sobald mindestens 0,75 x Frame-Intervall seit Renderstart
vergangen sind; er rendert aber nie schneller als `1 / targetFps`. Eine
60-fps-Webcam treibt den fused Pfad daher nicht mehr mit 60 Hz, wenn der
Helper auf 30 fps konfiguriert ist.

MediaFoundation bevorzugt einen angebotenen nativen Kamera-Typ mit maximal
30 fps und default maximal 1280x720 (`BROADIFY_MEETING_CAMERA_MAX_HEIGHT=720`;
Reopen-Pfade werden ebenfalls geklemmt). Die Subtype-Praeferenz ist NV12,
YUY2, MJPG, aber erst nachdem ein Kandidat mindestens 50 % der angefragten
Pixel erreicht; danach wird weiter RGB32 fuer den Helper ausgegeben. Der
ausgewaehlte native Typ wird als `camera_native_media_type_selected` geloggt.
Der MODNet-Maskenreadback bleibt auf Model-Resolution (512 -> 512x288 bei
16:9) und wird nicht auf Kamera-Aufloesung hochskaliert.

Der Windows-VCam-Default ist SHM (`Global\BroadifyVcam-control` +
`Global\BroadifyVcam-stream`), wobei die DLL die globalen Objekte im Frame
Server als `LOCAL SERVICE` erstellt und der Helper sie oeffnet. Die DLL
blockiert nicht mehr in der Aktivierung; Geometrie kommt sofort aus der
Control-Mapping oder aus dem Default 1920x1080@30. SHM-Samples nutzen den
QPC-Zeitstempel des Slots. BFRG v2 im TCP-Fallback traegt weiter
`capture_ns`; die VCam-DLL akzeptiert v1 und v2. Duplizierte Frames laufen mit
Frame-Dauer weiter.

Ab WP4c ist der teure SHM-Publish vom Program-Thread getrennt. Der
Program-Thread kopiert RGBA einmal in den zweifach gepufferten
`VcamShmPublisher`; der Publisher-Thread swizzelt RGBA -> BGRA direkt in den
Ring-Slot und setzt das Event. Bei Backpressure gilt latest-wins:
`metrics.vcam_publish_dropped` zaehlt verworfene pending Frames,
`metrics.vcam_publish_ms` misst die letzte Swizzle-/Publish-Laufzeit. Dadurch
blockiert die 8-MB-Swizzle-/Ring-Kopie nicht mehr Kamera-CV-Wake,
Hintergrundwechsel oder Keyer-Cadence-Entscheidungen.

Die Windows-VCam-DLL kopiert SHM-Payloads nur noch im
`MediaStream::RequestSample`-Pfad. Der Reader-Thread wartet weiter auf das
Frame-Event, aktualisiert Reader-Liveness und prueft Heartbeat/Generation/
2-s-No-Frame-Fallback, kopiert aber nicht mehr bei jedem Event.

Der Raw-Frame-Server sendet Heartbeats aus dem zuletzt gespeicherten Frame und
meldet `meeting_vcam_raw no_frame_on_connect`, wenn ein VCam-Client nach 2 s
noch keinen Frame bekommen hat. Die VCam-DLL schreibt beim ersten Logeintrag
einen Build-Stamp (`git_sha`, `build_time`) nach
`%ProgramData%\Broadify\vcam.log`.

## Messen

1. In Windows Task Manager die Spalten fuer GPU Engine/GPU-Auslastung oeffnen.
   Bei Hybrid-Geraeten pruefen, ob DirectML und D3D11 dieselbe GPU/LUID nutzen.
2. In `keyer.get` `gpu_adapter`, `compositor_adapter`,
   `keyer_pipeline_mode`, `degradation_stage`, `fallback_reason`, `provider`,
   `active_performance_mode`, `metrics.session_run_ms`,
   `metrics.program_frame_ms`, `metrics.vcam_publish_ms` und
   `metrics.vcam_publish_dropped` beobachten.
3. VCam-Verbrauch nur messen, wenn eine App wirklich streamt; eine bloss
   registrierte/armierte Kamera verbindet die DLL nicht dauerhaft.
