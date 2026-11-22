# ADR-0010: Meeting: Aufnahmeformat und Fähigkeiten

- Status: akzeptiert (Fähigkeitsmodell, Probe, Neustart-Regel und die Codecs des macOS-Recorders umgesetzt; HEVC unter
  Windows, 4K und 50/60 fps folgen in eigenen Schritten; der Windows-Teil von Probe und Recorder ist nicht auf
  Windows-Hardware geprüft)
- Datum: 2026-11-22

## Kontext
Das Meeting-Programm und seine Aufnahme sind heute fest: Programm 1920×1080 (oder 1080×1920, ADR-0007) mit 30 fps,
Aufnahme H.264 in `.mp4`. Bildrate, Auflösung und Codec sollen einstellbar werden (H.264, HEVC, ProRes; 25/30/50/60 fps;
bis 4K). Was davon geht, hängt am Rechner: ProRes- und HEVC-Hardware gibt es nicht überall, unter Windows gibt es keinen
lizenzierten ProRes-Encoder, und die Windows-Kamera ist auf 1080p und 30 fps begrenzt
(`capture/camera_mediafoundation.cpp`, `clampCameraCaptureRequest`). Die Web-App kann das nicht aus Plattform oder
Versionsnummer erraten.

Zwei Lücken im bisherigen Vertrag kamen dazu:

- `meeting_engine_start` verglich bei laufender Engine nur Breite und Höhe (ADR-0007: „Verglichen werden Breite und
  Höhe, nicht die Bildrate"). Ein Start mit anderer Bildrate war erfolgreich und ließ die alte Bildrate stehen – solange
  die Web-App immer 30 fps sendet, fällt das nicht auf; mit einstellbarer Bildrate wäre es ein stiller Fehler.
- Das Start-Schema nimmt jede Größe bis 7680×4320 und jede Bildrate bis 240 an, auch wenn dahinter kein geprüfter Pfad
  steht.

## Entscheidung
- **Fähigkeiten statt Plattform-Weichen.** `get_status.capabilities.meeting` (`MeetingCapabilitiesT`,
  `packages/protocol`) bekommt zwei optionale Felder; Vorbild ist `LiveProgramCapabilitiesT.recording`:
  - `program_formats { max_width, max_height, fps[] }` – was `meeting_engine_start` annimmt. Die Grenzen gelten für das
    Querformat; ein Hochformat wird mit vertauschten Kanten gemessen und braucht weiter `program_portrait`.
  - `recording { codecs[{ codec, container, max_height, max_fps }], upload_copy }` – was der Recorder auf diesem Rechner
    schreiben kann. `codec` ist `MeetingRecordingCodecT` (`h264`, `hevc`, `prores_422_lt`, `prores_422`,
    `prores_422_hq`), `container` folgt aus dem Codec (`mp4` oder `mov`).

  Beide Felder sind optional: ältere Bridges liefern sie nicht, ältere Web-Apps ignorieren sie. Die Web-App behandelt
  ein fehlendes Feld als „nicht unterstützt" und sendet neue Parameter nur, wenn die Fähigkeit gemeldet ist.
- **Gemeldet wird die Schnittmenge aus „kann der Recorder" und „kann der Rechner".** Eine benannte Liste
  (`MEETING_RECORDER_SUPPORTED_CODECS`, `services/meeting/meeting-capabilities.ts`) hält je Plattform fest, welche
  Codecs der Recorder schreibt: unter macOS H.264, HEVC und ProRes 422 LT/422/HQ, unter Windows nur H.264. Ein Codec
  erscheint nur, wenn er dort steht **und** die Probe einen Hardware-Encoder dafür gefunden hat. Die Liste wächst mit
  dem Recorder (siehe „Nachtrag: Codecs und Container").
- **Nur Hardware-Encoder, kein stiller Software-Rückfall** – dieselbe Doktrin wie beim Live-Programm und der
  PGM-Aufnahme (ADR-0002/0006/0009), jetzt auch für den Meeting-Recorder. Ein Codec ohne Hardware-Encoder wird nicht
  angeboten, statt auf der CPU zu laufen und Keyer und Programm das Zeitbudget zu nehmen. Die Doktrin gilt für das,
  was gemeldet wird, und unter macOS auch für den Recorder selbst: er verlangt für jeden Codec einen Hardware-Encoder
  und lehnt sonst mit Fehlercode ab (Nachtrag). Unter Windows schreibt der Recorder H.264 weiter über den Sink Writer
  mit `MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS` und wählt seinen Encoder noch nicht ausdrücklich; das kommt mit dem
  Windows-Schritt.
- **Eine Probe im Helper, ein Ergebnis je Bridge-Lauf.** `meeting-helper --probe-recording` gibt eine JSON-Zeile aus
  (`recording_probe`: `backend`, `ok`, `encoders[{ codec, name, vendor? }]`) und beendet sich, ohne Engine oder Gerät zu
  starten – nach dem Vorbild von `pgm-helper --probe`. macOS liest die VideoToolbox-Encoder-Liste und behält die
  hardwarebeschleunigten Encoder für H.264, HEVC und ProRes 422 LT/422/HQ. Windows zählt mit `MFTEnumEx`
  (`MFT_ENUM_FLAG_HARDWARE`) die Encoder-MFTs für H.264 und HEVC auf, in der Reihenfolge von
  `live_stream/mf_encoder_policy.h`; ProRes wird dort nie gemeldet. Der plattformneutrale Teil (Ergebnis, JSON) liegt
  in `recorder/recording_probe.{h,cpp}` und ist per ctest abgedeckt. `ok: false` heißt „Enumeration gescheitert", eine
  leere Liste mit `ok: true` heißt „kein Hardware-Encoder". Windows zählt H.264 und HEVC unabhängig voneinander auf:
  scheitert die Enumeration eines Codecs, fehlt nur dieser Codec; `ok: false` gibt es erst, wenn beide scheitern.
  `MeetingHelperManager.probeRecordingEncoders()` startet die Probe beim ersten `get_status` als eigenen Prozess mit 5 s
  Timeout und prüft die Zeile mit zod. Ein Ergebnis und ein endgültiges Scheitern (Helper fehlt, unlesbare oder zu
  lange Ausgabe, Enumeration gescheitert) gelten für den ganzen Bridge-Lauf. Ein vorübergehendes Scheitern (Timeout,
  Startfehler) wird wiederholt, insgesamt höchstens drei Läufe (`MEETING_RECORDING_PROBE_MAX_ATTEMPTS`): nur der erste
  `get_status` wartet auf die Probe; spätere Aufrufe stoßen die Wiederholung im Hintergrund an, antworten sofort ohne
  `recording`, und der Aufruf nach einer geglückten Wiederholung trägt das Feld. Solange kein Ergebnis vorliegt, fehlt
  `recording`, und die Bridge schreibt je gescheitertem Lauf eine Warnung mit dem Grund. Die Probe kann `get_status`
  nicht scheitern lassen. Sie ist nie Teil von `start()`: dieser Pfad muss ohne `await` bleiben (ADR-0007).
- **`program_formats` meldet den geprüften Rahmen, nicht das technisch Mögliche:** 1920×1080 mit 25 und 30 fps, auf
  allen Plattformen (`MEETING_PROGRAM_FORMAT_LIMITS`). 1080p ist die Größe, für die virtuelle Kamera und Windows-Kamera
  gebaut sind; 25 und 30 fps liegen innerhalb der 30-fps-Grenze der Windows-Kamera, und alle Takte der Pipeline
  (Programm, Keyer-Budget, Recorder, Keyframe-Abstand) leiten sich aus der Start-Bildrate ab. 4K und 50/60 fps werden
  erst gemeldet, wenn sie am Gerät gemessen sind. `program_formats` hängt nicht an der Probe und wird immer gemeldet.
- **Der Engine-Start prüft gegen `program_formats`.** Ein Start außerhalb wird mit dem neuen, stabilen Fehlercode
  `meeting_program_format_unsupported` abgelehnt – nach der Hochformat-Prüfung, vor jeder Änderung und unabhängig davon,
  ob eine Engine läuft (ein Neustart würde das Format nicht möglich machen).
- **Die Bildrate erzwingt einen Neustart.** Das löst die Aussage aus ADR-0007 ab: verglichen werden Breite, Höhe **und
  Bildrate** (`isSameProgramFormat`, vorher `isSameProgramGeometry`). Ein Start mit anderer Bildrate bei laufender
  Engine – oder während ein Start mit anderer Bildrate noch läuft – wird mit `meeting_engine_restart_required`
  abgelehnt. Alles Übrige aus ADR-0007 bleibt: die Bridge startet nie selbst neu, eine Ablehnung ändert nichts, läuft
  eine Aufnahme, nennt die Fehlermeldung das.

## Nachtrag: Codecs und Container (2026-11-22)
Der macOS-Recorder schreibt jetzt alle Codecs des Vertrags; der Codec wird je Aufnahme gewählt.

- **Der Codec bestimmt Container und Ton.** H.264 (High) und HEVC (Main, Sample-Entry `hvc1`, damit QuickTime und
  Apple-Player die Datei öffnen) gehen mit AAC in `.mp4`; ProRes 422 LT/422/HQ geht mit 24-Bit-PCM in `.mov`. Je Seite
  hält genau eine Tabelle das fest – `MEETING_RECORDING_CODEC_FORMATS` (`services/meeting/meeting-recording-codecs.ts`)
  und `kRecordingCodecFormats` (`recorder/recording_codec.h`) –, und ein Test vergleicht beide Zeile für Zeile.
  Pfadprüfung, Standardpfad und Speichern-Dialog lesen die Endung aus der Bridge-Tabelle; die Endung muss zum Codec
  passen.
- **`codec` ist ein optionaler Parameter** von `meeting_recording_start`, `meeting_recording_toggle` und
  `meeting_recording_pick_path`. Ohne ihn bleibt es bei H.264 in `.mp4`: so starten ältere Web-Apps und die
  REC-Taste des Stream Decks, wie die Web-App sie heute einrichtet (ohne Codec in der Payload; eine Tastenbelegung mit
  `codec` würde wie ein Start geprüft und befolgt). Ein angegebener Codec muss in
  `capabilities.meeting.recording.codecs` stehen, sonst lehnt die Bridge mit `meeting_recording_codec_unsupported` ab,
  bevor der Dialog aufgeht oder der Helper gefragt wird – auch bei einem Namen, den diese Bridge nicht kennt. Ein
  Start ohne `codec` wird nicht an den Fähigkeiten geprüft, damit die Aufnahme nicht von der Probe abhängt. Ein Toggle
  liest die Payload nur, wenn er eine Aufnahme startet: stoppen kann er immer.
- **Der macOS-Recorder verlangt Hardware und fällt nicht zurück.** Er fragt vor dem Anlegen der Datei die
  VideoToolbox-Encoder-Liste (dieselbe Enumeration wie die Probe) und setzt an jedem Video-Eingang
  `kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder`. Gemessen (M1 Pro): `AVAssetWriter` wertet die
  Vorgabe in `startWriting` aus und scheitert dort mit `kVTCouldNotFindVideoEncoderErr`, wenn sie nicht erfüllbar ist –
  für H.264, HEVC und ProRes. Beides führt zu `meeting_recording_codec_unsupported`. Das gilt auch für den Start
  ohne `codec`: auf einem Mac ohne H.264-Hardware (praktisch nur virtuelle Maschinen) wird er jetzt abgelehnt, wo der
  Writer vorher in Software encodiert hätte. Grenze: `AVAssetWriter` nennt den
  benutzten Encoder nicht; geprüft ist, dass die Vorgabe durchgesetzt wird, nicht der Name des Encoders.
- **Datenrate je Codec** in der gemeinsamen Policy (`helper_common/recording_encode_policy.h`): H.264 unverändert
  (0,35 bit/px, 2–40 Mbit/s; die PGM-Aufnahme nutzt dieselbe Funktion und bekommt dieselben Werte), HEVC 60 % davon,
  ProRes nach Apples veröffentlichten Zielraten (102/147/220 Mbit/s bei 1080p29,97, skaliert mit Pixeln und Bildrate;
  der Encoder bekommt keine Bitrate). 60 % statt der oft genannten 50 %, weil der Recorder in Echtzeit, in Hardware und
  ohne Bild-Umsortierung encodiert. Die 40-Mbit/s-Grenze bleibt, bis 4K gemeldet wird.
- **Freier Speicher im Verhältnis zur Datenrate:** ein Start braucht Platz für fünf Minuten zur erwarteten Datenrate
  des Codecs (H.264 1080p30 rund 0,8 GB, ProRes 422 HQ rund 8,3 GB) statt fest 500 MB; sonst
  `recording_disk_space_low` mit benötigten und freien Bytes. Der Code ersetzt `disk_full`; als Meldung (`error`)
  bleibt `disk_full` stehen, weil Web-Apps vor diesem Code nur dieses Wort kennen und es auch in der Meldung suchen.
- **Stopp-Zeiten:** `meeting_recording_stop` ist in der Bridge-Policy mit 35 s Relay-Timeout und 30 s lokaler SLA
  deklariert wie `pgm_recording_stop`. Vorher (12 s / 8 s) lag beides unter dem Abschluss der Datei (bis 15 s) und dem
  RPC (20 s). Die Bridge bricht selbst keinen Befehl ab (die SLA löst nur eine Warnung im Log aus); wirksam wird die
  Zeit erst mit passenden Einträgen für `meeting_recording_stop` und `meeting_recording_toggle` in den Tabellen des
  Relay-Dienstes und der Web-App.
- **Windows:** der Recorder nimmt dieselbe Anfrage (`RecordingRequest`) entgegen, schreibt nur H.264 und lehnt jeden
  anderen Codec mit `meeting_recording_codec_unsupported` ab. ProRes wird es dort nicht geben.

Verworfen: **der Stream-Deck-Taste den zuletzt in der Web-App gewählten Codec geben** – die Wahl liegt in der Web-App
und nicht in der Bridge; die Bridge müsste sie speichern oder erraten. **Jede Endung annehmen und den Container aus
der Endung ableiten** – dann hätten Endung und Codec zwei Quellen. **Software-ProRes auf Macs ohne ProRes-Hardware**
– siehe Doktrin.

## Alternativen
- **Plattform-Weiche in der Web-App** („macOS kann ProRes, Windows nicht"): verworfen. Ob HEVC- oder ProRes-Hardware da
  ist, hängt am einzelnen Rechner (ProRes-Hardware haben nur manche Apple-Chips, HEVC unter Windows nur manche GPUs und
  Treiber), und die Web-App müsste bei jeder Recorder-Änderung mitgezogen werden.
- **Encoder in der Bridge (Node) ermitteln**, etwa über Systemwerkzeuge: verworfen. Die Auskunft muss von derselben API
  kommen, über die der Recorder später encodiert, und der Helper hat diese Abhängigkeiten schon.
- **Probe als RPC des laufenden Helpers**: verworfen. Die Fähigkeiten werden vor dem Engine-Start gebraucht (die
  Einstellungsseite zeigt sie ohne laufende Engine), und der Start-Pfad soll keine weitere Wartezeit bekommen.
- **Probe bei jedem `get_status`** oder unbegrenzte Wiederholung nach einem Scheitern: verworfen. Die Encoder ändern
  sich während eines Bridge-Laufs praktisch nicht, und ein hängender Helper würde sonst jede Statusabfrage um das
  Timeout verzögern.
- **Jedes Scheitern für den Bridge-Lauf behalten**: verworfen. Ein einzelner langsamer Kaltstart des Helpers (unter
  Windows mit seinen DLLs und einem möglichen Virenscan nicht gemessen) hätte `recording` bis zum nächsten Bridge-Start
  versteckt. Deshalb die begrenzte Wiederholung im Hintergrund, nur für vorübergehende Gründe.
- **Software-Encoder als Rückfall melden**: verworfen, siehe Doktrin. ProRes in Software kostet mehrere CPU-Kerne, die
  der Keyer braucht.
- **Alle Codecs der Probe sofort melden**: verworfen. Die Web-App würde Formate anbieten, die der Recorder noch nicht
  schreiben kann.
- **Bildrate im laufenden Helper wechseln**: verworfen aus demselben Grund wie der Formatwechsel in ADR-0007 – Takt der
  Pipeline, Encoder, Recorder und die Ringe der virtuellen Kamera sind auf eine feste Bildrate angelegt.
- **Bildraten-Wechsel weiter still annehmen**: verworfen. Die Web-App bekäme „Erfolg" und eine Aufnahme mit der falschen
  Bildrate.

## Folgen
- Neue Vertragsteile (additiv): `capabilities.meeting.program_formats`, `capabilities.meeting.recording`, die Typen
  `MeetingRecordingCodecT`, `MeetingRecordingContainerT`, `MeetingRecordingFormatT` und der Fehlercode
  `meeting_program_format_unsupported`. Beschrieben in `docs/bridge/features/meeting-status-contract.md` und
  `meeting-recording.md`.
- **Verhaltensänderung für bestehende Clients:** `meeting_engine_start` mit einer anderen Bildrate als der laufenden
  liefert jetzt `meeting_engine_restart_required` statt Erfolg, und ein Start außerhalb von 1920×1080 / 25 / 30 fps wird
  abgelehnt. Die heutige Web-App sendet immer 30 fps und höchstens 1920×1080 bzw. 1080×1920 und behandelt
  `meeting_engine_restart_required` bereits (ADR-0007); ihr Vergleich in `lib/meeting/meeting-engine-start.ts`
  (`acceptsGeometry`) muss die Bildrate mit aufnehmen, sobald sie eine andere Bildrate senden kann. Der Crash-Restart
  wiederholt die Optionen des laufenden Starts und ist nicht betroffen; der Conference-Modus startet die Engine nicht
  selbst.
- Der erste `get_status` eines Bridge-Laufs startet einen kurzlebigen Helper-Prozess (auf einem M1 Pro gemessen: rund
  1,4 s kalt) und wartet höchstens 5 s darauf. Nach einem Timeout oder Startfehler starten spätere `get_status` bis zu
  zwei weitere Läufe, ohne darauf zu warten; `recording` erscheint dann erst in der Statusabfrage nach dem geglückten
  Lauf. Der lokale Status (`GET /video/status`) startet die Probe nie und zeigt
  `recording` erst danach.
- Mit jedem Codec, den ein Recorder lernt, wächst `MEETING_RECORDER_SUPPORTED_CODECS`; mit jeder Messung am Gerät wachsen
  `MEETING_PROGRAM_FORMAT_LIMITS` – dann voraussichtlich je Plattform und je Codec verschieden (`max_height`/`max_fps`
  je Eintrag sind dafür schon im Vertrag).
- Auf Macs ohne ProRes-Hardware wird ProRes unter dieser Doktrin nicht angeboten. Das ist so entschieden (2026-11-22):
  ProRes gibt es nur, wo die Probe ProRes-Hardware meldet.
- Die virtuelle Kamera unter macOS liefert fest 30 fps (`VCamDeviceSource.swift`); bei einem 25-fps-Programm
  wiederholt sie Bilder ungleichmäßig. Die Aufnahme ist davon nicht betroffen.
- Nur am Gerät prüfbar: der gesamte Windows-Teil der Probe und des Recorders (`recording_probe_mediafoundation.cpp`
  und `meeting_recorder_mediafoundation.cpp` sind auf macOS nicht übersetzbar), ein 25-fps-Programm mit echter Kamera,
  virtueller Kamera und Aufnahme auf beiden Plattformen, und eine Aufnahme je Codec aus der laufenden Engine mit
  Mikrofon (die Codecs sind mit dem eigenständigen Writer-Test geprüft, nicht im Helper-Betrieb).
