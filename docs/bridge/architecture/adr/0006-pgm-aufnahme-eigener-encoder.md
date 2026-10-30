# ADR-0006: Die PGM-Aufnahme bekommt einen eigenen H.264-High-Hardware-Encoder

- Status: akzeptiert
- Datum: 2026-10-30

## Kontext
Die Studio-Aufnahme nimmt das Programmbild des Mischers (USB/UVC) als MP4 auf. Bis v0.27.3-rc.21 lieferte **derselbe**
VideoToolbox-Encoder die WebRTC-Vorschau und die Datei (`pgm_engine.cpp`: ein `encoder_`, Fan-out in `onAccessUnit`).
Der Vorschau-Encoder ist auf Vorschau getrimmt: H.264 Main, `RealTime`, `PrioritizeEncodingSpeedOverQuality`, hartes
1-s-`DataRateLimits` und die Vorschau-Leiter (1080p30 = 5/7,5 Mbit/s; `remote` = 720p30, 2,5 Mbit/s). Folgen für die
Datei: Vorschauqualität im Archiv, ein `remote`-Zuschauer schrumpft die Aufnahme beim nächsten Signalwechsel auf
720p, jedes PLI und jeder neue Zuschauer erzwingt einen Keyframe in der Datei. Gabriel (30.10.2026): eigener Encoder in
H.264 High mit der Archiv-Bitrate der Meeting-Aufnahme; ein Signalwechsel während der Aufnahme ist eine Lücke, die
Datei bleibt gültig; Status- und Capability-Felder werden sofort mitgeliefert. 4K bleibt außen vor (Capture ≤ 1080p).

## Entscheidung (Ansatz A)
- Ein **zweiter `VideoToolboxEncoder`** (`live_stream`) nur für die Aufnahme. `EncodeTarget` bekommt die Optionen
  `h264Profile` (Main|High), `prioritizeSpeed` und `hardRateLimit`; die Vorschau behält ihre Defaults byte-identisch
  (`selectEncodeTarget` unverändert, Wächter in `bitrate_ladder_test`). Neu `selectRecordingTarget(w, h, fpsNum, fpsDen)`
  (`profileName = "archive"`): Geometrie wie der LAN-Zweig (≤ 1080 Zeilen, Quell-fps) **unabhängig** vom Zuschauer-
  Profil, Bitrate aus der gemeinsamen Policy, `maxBitrateKbps = 1,5 ×` Mittel ohne hartes 1-s-Limit, GOP 2 s, CABAC,
  High AutoLevel, keine Umsortierung, `RealTime` bleibt an (die Capture-Queue darf nicht stauen).
- Die **Encode-Policy** (0,35 Bit/px, Klammer 2–40 Mbit/s, GOP `fps × 2`, `kRecorderFinalizeTimeoutMs = 15 000`) zieht
  wortgleich aus dem Meeting-Helper nach `helper-common/include/helper_common/recording_encode_policy.h`
  (`broadify::helper`); der Meeting-Helper re-exportiert sie per `using` und bleibt verhaltensgleich.
- Der bestehende **Passthrough-`Mp4Recorder`** (AVAssetWriter, `.part` + Rename, AAC 48 kHz, Start am ersten Keyframe)
  bleibt unverändert und bekommt nur noch die Samples des Aufnahme-Encoders. Das Finalize-Literal weicht der
  gemeinsamen Konstante; `scripts/pgm-helper-release-contract.test.cjs` hält sie unter `pgm.recording.stop` (20 s),
  dem Bridge-SLA (30 s) und dem Relay-Timeout (35 s).
- **Signalwechsel** während der Aufnahme (`RecordingSignalGate`, rein): weicht die Geometrie (Breite/Höhe/Pixelformat)
  von der Start-Geometrie ab, werden die Frames übersprungen (Ereignis `pgm_recording_signal_mismatch` je Episode);
  kehrt sie zurück, läuft die Aufnahme mit erzwungenem Keyframe weiter. Ein reiner fps-Wechsel wird toleriert.
- ADR-0002 bleibt gewahrt: `RequireHardwareAcceleratedVideoEncoder` gilt auch für den Aufnahme-Encoder; ohne zweiten
  Hardware-Slot schlägt `pgm_recording_start` sichtbar mit `encoder_unavailable` fehl. Kein stiller Software-Fallback.
- Vorschau-Gate: nur noch `encoderConfigured_ && viewerCount() > 0`; die Aufnahme hält den Vorschau-Encoder nicht mehr am
  Laufen. `profile_` (lan/remote) wirkt nur noch auf die Vorschau.

## Alternativen
- **Ansatz B**: Neukodierung im AVAssetWriter aus NV12 wie der Meeting-Recorder. Verworfen: AVAssetWriter fällt still
  auf Software zurück (bricht ADR-0002), Writer-Factory und CFR-Uhr müssten aus `broadify::meeting` kopiert werden
  (nicht linkbar), ein weiteres AVFoundation-Testtarget.
- **Vorschau-Encoder umparametrieren** (High, höhere Bitrate): Vorschau und Datei hingen weiter aneinander (PLI,
  Zuschauer-Profil, Keyframes), WebRTC-Egress stiege auf Archiv-Bitrate.
- Präzedenz für zwei parallele Hardware-Sessions: der Meeting-Helper fährt bereits VT-Vorschau und AVAssetWriter-
  Aufnahme nebeneinander.

## Folgen
- Plattenbedarf: 1080p25 18,1 · 1080p30 21,8 · 1080p50 36,3 · 1080p60 40 (Deckel) · 720p30 9,7 Mbit/s, also
  ≈ 10 GB/h bei 1080p30 und ≈ 18 GB/h bei 1080p60. Standardordner und Speicherdialog bleiben; Hinweis in der Web-App
  folgt separat.
- Drei Halter der NV12-Capture-Buffer (Vorschau-VT, Aufnahme-VT, Snapshot `latestFrame_`): Symptom einer Pool-
  Erschöpfung wäre `capture_fps` unter der Signalrate (`pgm_perf`); Gegenmaßnahme bei Bedarf ein eigener
  `CVPixelBufferPool` für den Aufnahmepfad.
- `prioritizeSpeed = false` erhöht die VT-Latenz nur auf der Aufnahme-Session; die Vorschau ist unverändert.
- Ältere Intel-Macs: zwei Quick-Sync-Sessions sind möglich; das Fehlerbild wäre ein sichtbares `encoder_unavailable`
  beim Start.
- Neue Felder (additiv): `pgm_status.recording.{profile, bitrate_kbps, width, height, fps_num, fps_den, frames}`,
  `capabilities.live_program.recording_profile = "high"`, `pgm_perf.{recording_fps, recording_kbps, recording_dropped}`,
  Ereignisse `pgm_recording_signal_mismatch` und `pgm_recording_fps_changed`.
- Nur am Gerät prüfbar: ffprobe (`profile=High`, Bitrate ≈ Ziel, `avg_frame_rate` = Quelle, BT.709-Tags), Keyframe-
  Kadenz ≈ 2 s trotz PLI/Zuschauerwechsel, Finalize-Dauer bei langen Dateien.
