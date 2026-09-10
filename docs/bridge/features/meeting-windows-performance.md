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

Der finale D3D11-Compositor-Readback nutzt **default den Staging-Ring**
(Tiefe 3, mappt Frame N-1) statt eines blockierenden `Map` auf den aktuellen
Frame — das entfernt pro Frame einen vollen GPU-Sync aus dem Program-Loop,
kostet dafuer maximal einen Frame zusaetzliche Ausgabelatenz. Kill-Switch:
`BROADIFY_MEETING_STAGING_RING=0` stellt den rc.18-Zustand (blockierender
Copy/Map, rc.12-Latenz) wieder her. `metrics.staging_readback_depth` meldet
die Ring-Tiefe (3 aktiv, `0` bei gesetztem Kill-Switch). Der
Guided-Refine-Readback bleibt current-frame (das war die eigentliche
rc.18-Ghost-Ursache), unabhaengig von diesem Schalter.

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

### rc.32a: 1080p Capture-Budget

MediaFoundation rotiert die Windows-Programmkamera jetzt ueber drei RGBA-
Puffer (`scratch`, `latest`, Consumer) per Pointer-Swap. Der Program-Loop
nimmt neue Frames mit `takeLatestFrameIfNew`, waehrend `copyLatestFrame*` fuer
andere Lesepfade unveraendert bleibt. Im Feld sollte
`keyer.get.metrics.camera_copy_ms` bei 1920x1080 unter 0,1 ms liegen.

Der Governor bekommt weiterhin nur echte Session-/Inferenzkosten als Sample.
Das restliche Program-Frame-Budget wird separat als `frame_overhead_ms`
geglaettet und reduziert die Step-down-/Step-up-Schwelle sowie die fused
Cadence-Budgetrechnung. Ein Floor von 50 Prozent des Basisbudgets verhindert,
dass Overhead allein unter `performance`/256 drueckt; Kameraaufloesung wird
nie reduziert.

`keyer.get.metrics` enthaelt auf Windows zusaetzlich
`camera_upload_ms`, `frame_overhead_ms`, `budget_threshold_ms` und
`prepass_gpu` (aktuell `false`). Bei anhaltender Ueberschreitung meldet der
Helper hoechstens alle 10 s `keyer_budget_overrun` mit Program-/Session-/
Tensor-/Copy-/Upload-Kosten, Tier und Cadence-N; wenn die EMA wieder unter das
Budget faellt, folgt `keyer_budget_recovered`.

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
30 fps und default maximal 1920x1080 (`BROADIFY_MEETING_CAMERA_MAX_HEIGHT=1080`;
`0` deaktiviert die Hoehenklemme; Reopen-Pfade werden ebenfalls geklemmt).
Die Subtype-Praeferenz ist NV12, YUY2, MJPG, entscheidet aber nur bei gleicher
Pixelzahl innerhalb derselben Groessenklasse; ein kleinerer Raw-Typ darf einen
gleich schnellen 1080p-Typ nicht verdraengen. Danach wird weiter RGB32 fuer den
Helper ausgegeben. Der ausgewaehlte native Typ wird als
`camera_native_media_type_selected` in die Sidecar-Events geloggt. Der
MODNet-Maskenreadback bleibt auf Model-Resolution (512 -> 512x288 bei 16:9)
und wird nicht auf Kamera-Aufloesung hochskaliert; der gemessene Trade-off
1080p Capture + 512er Keyer wird im Feld bestaetigt.

Der Windows-VCam-Default ist SHM (`Global\BroadifyVcam-control` +
`Global\BroadifyVcam-stream`), wobei die DLL die globalen Objekte im Frame
Server als `LOCAL SERVICE` erstellt und der Helper sie oeffnet. Die DLL
blockiert nicht mehr in der Aktivierung; Geometrie kommt sofort aus der
Control-Mapping oder aus dem Default 1920x1080@30. SHM-Samples nutzen den
QPC-Zeitstempel des Slots. BFRG v2 im TCP-Fallback traegt weiter
`capture_ns`; die VCam-DLL akzeptiert v1 und v2. Duplizierte Frames laufen mit
Frame-Dauer weiter.

Ab WP4c ist der teure SHM-Publish vom Program-Thread getrennt. Der
Program-Thread uebergibt RGBA per Pointer-Swap in den dreifach gepufferten
`VcamShmPublisher`; der Publisher-Thread swizzelt RGBA -> BGRA direkt in den
Ring-Slot und setzt das Event. Bei Backpressure gilt latest-wins:
`metrics.vcam_publish_dropped` zaehlt verworfene pending Frames,
`metrics.vcam_publish_ms` misst die letzte Swizzle-/Publish-Laufzeit und ist
`-1`, bis der erste Publish abgeschlossen ist. Dadurch blockiert die
8-MB-Swizzle-/Ring-Kopie nicht mehr Kamera-CV-Wake, Hintergrundwechsel oder
Keyer-Cadence-Entscheidungen.

Die Windows-VCam-DLL kopiert SHM-Payloads nur noch im
`MediaStream::RequestSample`-Pfad. Der Reader-Thread wartet weiter auf das
Frame-Event, aktualisiert Reader-Liveness und prueft Heartbeat/Generation/
2-s-No-Frame-Fallback, kopiert aber nicht mehr bei jedem Event.

Solange die DLL noch kein Control-/Stream-Mapping oder nur Null-Geometrie
sieht, pollt sie SHM nach 1 s erneut. Nach einem geoeffneten, aber stalen
Mapping bleibt der Backoff bei 5 s. In der Feldmessung sollte SHM damit
innerhalb von ca. 3 s nach Helper-Start sichtbar werden.

Gerenderte Content-/Deck-Seiten werden nicht mehr auf dem Render-Thread
dekodiert. Der Helper haelt bis zu vier dekodierte Seiten im LRU-Cache, laedt
Seiten auf einem Worker und zeigt beim Seitenwechsel die zuletzt dekodierte
Seite weiter, bis die neue Seite bereit ist. Prefetch laeuft fuer die
0-basierte Steuerseitenzahl `page +/- 1`; Dateinamen sind 1-basiert, deshalb
wird z. B. bei `page: 2` und `page-0003.png` `page-0002.png` und
`page-0004.png` vorgeladen. Das passiert nur, wenn der Pfad ein eindeutiges
Seitennummern-Muster enthaelt; bei nicht-deterministischen Pfaden wird nichts
vorab geladen.
Erfolg und Fehler stehen als `media_page_loaded` bzw.
`media_page_load_failed` in den Helper-Events.

Der Raw-Frame-Server sendet Heartbeats aus dem zuletzt gespeicherten Frame und
meldet `meeting_vcam_raw no_frame_on_connect`, wenn ein VCam-Client nach 2 s
noch keinen Frame bekommen hat. Die VCam-DLL schreibt beim ersten Logeintrag
einen Build-Stamp (`git_sha`, `build_time`) nach
`%ProgramData%\Broadify\vcam.log`.

## rc.11: Perf-Pakete (Keyer-Last / Luefter)

Aufbauend auf rc.10. Ziel: Pro-Frame-CPU/GPU-Last senken — das ist der gemeinsame
Hebel fuer Performance, Luefterlautstaerke und Qualitaet, weil der Keyer-Governor
unter Last die Matte-Aufloesung senkt (512 -> 320 -> 256).

- **Keyer-Thread-Prioritaet (A2):** Der Async-Keyer-Worker (schwerster Thread)
  bekommt jetzt ebenfalls `AvSetMmThreadCharacteristicsW(L"Capture")`, nicht mehr
  nur Program-/Sender-Thread. Unter dem `BROADIFY_MEETING_WIN_QOS`-Schalter.
- **Weniger Pro-Frame-Allokationen (C2):** Der CPU-Guided-Filter und die
  Masken-Morphologie im Keyer-Postprocess nutzen wiederverwendete Scratch-Puffer
  statt pro Frame ~2 Dutzend Vektoren zu allozieren. Mathematik unveraendert.
- **AVX2-Luma fuer VCam-NV12 (A3):** BGRA->NV12-Y-Ebene laeuft mit einem
  AVX2-Kernel (Runtime-`cpuHasAvx2()`-Dispatch, Scalar-Fallback, bit-exakt). Kein
  globales `/arch:AVX2`. Betrifft den echten Kamerapfad (die vcam-helper-DLL nutzt
  dieselbe `bgraToNv12`).

### fp16-Keyer (B2, Experiment)

`BROADIFY_MEETING_KEYER_FP16=1` laesst den Keyer ein halbpraezises MODNet-Modell
laden (DirectML, ~2x Durchsatz auf faehigen GPUs -> hoehere Tier-Haltung unter
Last, weniger GPU-Zeit). **Default aus.** Die I/O-Praezision wird aus dem
tatsaechlich geladenen Modelltyp abgeleitet, nie aus dem Flag allein — ein
fp32-Modell nimmt immer den fp32-Pfad. Der Schalter greift nur, wenn zusaetzlich
ein deployter `modnet-fp16`-Eintrag vorhanden ist; sonst bleibt der Keyer
transparent auf fp32 (Log-Event `fp16_requested_no_model`).

fp16-Modell bereitstellen:

1. `python scripts/convert-modnet-fp16.py --input <modnet.onnx> --output modnet_fp16.onnx`
   (benoetigt `pip install onnx onnxconverter-common`). Der Befehl gibt den
   SHA-256 aus. Matte-Qualitaet einmal gegen fp32 pruefen.
2. `modnet_fp16.onnx` hosten und `MODNET_FP16_MODEL_URL` als Secret setzen
   (Windows-Job, analog `MODNET_MODEL_URL`).
3. In `models/manifest.json` den `modnet-fp16`-`sha256` vom Platzhalter auf den
   echten Hash setzen und committen. `download-modnet-model.sh` laedt das Modell
   dann verifiziert; ohne Hash/URL ist der Schritt ein No-op (fp32 unveraendert).

### IoBinding (B1, Experiment)

`BROADIFY_MEETING_KEYER_IO_BINDING=1` fuehrt die DirectML-Inferenz ueber
ORT-IoBinding. **Default aus.** Aktuell mit CPU-seitigem Input nur ein moderater
Effekt; existiert als Naht fuer kuenftigen Zero-Copy-GPU-Input und als
A/B-Toggle. Fail-safe: jeder Fehler deaktiviert den Pfad prozessweit und faellt
auf den normalen `Run` zurueck; nur auf dem DirectML-Provider aktiv.

### Zero-Copy-Device-Input (C3, Experiment)

`BROADIFY_MEETING_KEYER_ZEROCOPY=1` baut den MODNet-Eingangs-Tensor per
D3D12-Compute-Shader direkt aus dem hochgeladenen RGBA-Frame in einen
Default-Heap-Buffer und bindet ihn ueber die IoBinding-Naht als DML-Device-Input
(`keyer/dml_device_input.cpp`). **Default aus.** Ersetzt den CPU-Tensor-Build
(`buildModnetInputTensor`) plus ORTs internen CPU->GPU-Input-Copy; der
Output-Readback bleibt CPU. Randbedingungen:

- Nur auf dem `dml1_selected_adapter`-Pfad aktiv: dort besitzt der Keyer das
  D3D12-Device und die Command-Queue, auf der der DML-EP ausfuehrt; der
  Preprocessing-Dispatch wird auf derselben Queue vor dem `Run` submittet und
  ist damit ohne Cross-Queue-Fences geordnet. Auf `dml2`/`legacy_device0`
  meldet `zerocopy_stage_unavailable` den Grund und der CPU-Pfad laeuft
  unveraendert.
- Der Shader repliziert die CPU-Referenz exakt (Letterbox, Integer-
  Block-Average, `(x-0.5)/0.5`); ein einmaliges Paritaets-Gate pro Tier
  (`zerocopy_parity`, max |Delta| <= 1e-2 elementweise gegen
  `buildModnetInputTensor`) muss bestehen, bevor eine Maske aus dem GPU-Tensor
  vertraut wird. fp16-Modelle schreiben den Tensor direkt als half
  (R16_FLOAT-UAV), die CPU-seitige fp32->fp16-Konvertierung entfaellt.
- Fail-safe: jeder D3D-/ORT-Fehler oder ein Paritaets-Miss deaktiviert den
  Pfad prozessweit (`zerocopy_disabled`) und der Frame laeuft noch in
  derselben apply() ueber den heutigen CPU-Tensor-Pfad weiter.

Der Keyer-Self-Test gibt zur Zuordnung zusaetzlich die Phasen-Mittel
`tensor_ms`, `session_run_ms` und `mask_apply_ms` pro Groesse aus.

**Feldbefund (Default-off):** Auf einer overhead-gebundenen GPU (GTX 1660 Ti,
`split`-Policy, Live-1080p) bringt `ZEROCOPY` keinen Nettogewinn und kostet
leicht mehr GPU-Takt/Luefter (+~2 W / +~140 MHz Boost gemessen). Der GPU-gebaute
Tensor ist kanalweise identisch zum CPU-Pfad (R/B-Swap ausgeschlossen), aber die
eingesparte CPU-Tensor-Arbeit ist hier nicht der Flaschenhals — `session_run`
(der ~17-ms-Dispatch/Fence/Readback-Boden) bleibt unveraendert. Die Naht bleibt
sinnvoll fuer CPU-Tensor-gebundene Hardware (schwache CPU, ORT-Input-Copy
dominiert); dort lohnt ein erneutes A/B.

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
