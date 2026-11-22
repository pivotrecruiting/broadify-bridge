# ADR-0010: Meeting: Aufnahmeformat und Fähigkeiten

- Status: akzeptiert (Fähigkeitsmodell, Probe und Neustart-Regel umgesetzt; weitere Codecs, 4K und 50/60 fps folgen in
  eigenen Schritten; der Windows-Teil der Probe ist nicht auf Windows-Hardware geprüft)
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
  (`MEETING_RECORDER_SUPPORTED_CODECS`, `services/meeting/meeting-capabilities.ts`) hält fest, welche Codecs der
  Recorder schreibt – heute nur H.264 in `mp4`. Ein Codec erscheint nur, wenn er dort steht **und** die Probe einen
  Hardware-Encoder dafür gefunden hat. HEVC und ProRes werden also noch nicht gemeldet, auch wenn der Rechner sie
  beherrscht; die Liste wächst mit dem Recorder.
- **Nur Hardware-Encoder, kein stiller Software-Rückfall** – dieselbe Doktrin wie beim Live-Programm und der
  PGM-Aufnahme (ADR-0002/0006/0009), jetzt auch für den Meeting-Recorder. Ein Codec ohne Hardware-Encoder wird nicht
  angeboten, statt auf der CPU zu laufen und Keyer und Programm das Zeitbudget zu nehmen. Stand dieses ADR: die Doktrin
  gilt für das, was gemeldet wird. Der Recorder selbst schreibt H.264 weiter über `AVAssetWriter` (macOS) bzw. den
  Sink Writer mit `MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS` (Windows) und wählt seinen Encoder noch nicht ausdrücklich;
  das ausdrückliche Wählen und der Fehlercode statt Rückfall kommen mit den Codec-Schritten.
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
- `meeting_recording_start` wertet die neuen Felder noch nicht aus; die Aufnahme bleibt H.264 in `.mp4`. Mit jedem
  Codec, den der Recorder lernt, wächst `MEETING_RECORDER_SUPPORTED_CODECS`; mit jeder Messung am Gerät wachsen
  `MEETING_PROGRAM_FORMAT_LIMITS` – dann voraussichtlich je Plattform und je Codec verschieden (`max_height`/`max_fps`
  je Eintrag sind dafür schon im Vertrag).
- Auf Macs ohne ProRes-Hardware wird ProRes unter dieser Doktrin nicht angeboten werden. Ob das so bleiben soll, ist vor
  dem ProRes-Schritt zu entscheiden; ein Abweichen wäre ein eigenes ADR.
- Die virtuelle Kamera unter macOS liefert fest 30 fps (`VCamDeviceSource.swift`); bei einem 25-fps-Programm
  wiederholt sie Bilder ungleichmäßig. Die Aufnahme ist davon nicht betroffen.
- Nur am Gerät prüfbar: der gesamte Windows-Teil der Probe (`recording_probe_mediafoundation.cpp` ist auf macOS nicht
  übersetzbar), ein 25-fps-Programm mit echter Kamera, virtueller Kamera und Aufnahme auf beiden Plattformen.
