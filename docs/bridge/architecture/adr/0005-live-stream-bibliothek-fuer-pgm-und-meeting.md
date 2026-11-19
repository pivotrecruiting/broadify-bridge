# ADR-0005: Gemeinsame `live_stream`-Bibliothek für PGM- und Meeting-Helper

- Status: akzeptiert
- Datum: 2026-10-24

## Kontext
Das Live-Programm (ADR-0002/0004) bringt einen Hardware-H.264-Encoder (VideoToolbox) und einen libdatachannel-
Publisher in den PGM-Helper. Die Meeting-Vorschau (zusammengesetztes Kamerabild mit Keyer, Hintergrund und
Grafiken) zeigte dasselbe Bild bisher nur als MJPEG an `127.0.0.1` auf dem Bridge-Rechner, also nicht im WLAN,
nicht remote und nicht im schwebenden Fenster der Web-App. Gabriel will beide Bilder über denselben Viewer sehen,
mit sauberer Aufnahme (kein Ruckeln) und ohne den Rechner zusätzlich zu belasten.

## Entscheidung
- Encoder-Abstraktion, VideoToolbox-Encoder, Annex-B-Helfer, Bitraten-Leiter, Monotonic-Clock, Zuschauer-Typen
  und der WebRTC-Publisher ziehen aus dem PGM-Helper in eine statische Bibliothek
  `apps/bridge/native/live-stream` (Namespace `broadify::live`, Targets `live_stream_core` ohne Abhängigkeiten
  und `live_stream` mit libdatachannel/VideoToolbox, nur macOS bis der Media-Foundation-Encoder kommt). Die
  FetchContent-Konfiguration für libdatachannel lebt dort. Der PGM-Helper macht die Typen per
  `using namespace ::broadify::live` in `broadify::pgm` sichtbar (`src/common/live_types.h`); keine Weiterleitungs-
  Header.
- Der Meeting-Helper bekommt `ProgramStream` (`src/live/program_stream.mm`, Stub für andere Plattformen): eigener
  Thread, der aus dem vorhandenen `PreviewFrameStore` zieht. Ohne Zuschauer wird nichts kopiert und nichts
  kodiert; mit Zuschauern wandert jedes neue Programmbild in einem Durchgang (RGBA→BGRA, SIMD) in einen gepoolten,
  IOSurface-gestützten `CVPixelBuffer` und asynchron in VideoToolbox. Die Frame-Pipeline (virtuelle Kamera,
  Aufnahme) wartet nie auf den Encoder; ein nicht annehmbares Bild wird verworfen, nie gepuffert. Der Publisher
  meldet Zuschauerzustände als `meeting_viewer_state`.
- RPC des Meeting-Helpers: `program.viewer.offer`, `program.viewer.close`, `program.sessions.list`,
  `program.stream.status`. Bridge-Befehle `meeting_program_offer/close/sessions/status` mit denselben zod-Schemata
  wie `pgm_webrtc_*`, Mode-Gate Meeting, Berechtigung `bridges:view_program`; Zuschauer-Sessions in
  `services/meeting/meeting-program-stream.ts` (Grenze, Bindung an den Nutzer, Abgleich gegen den Helper).
- Web: ein Viewer (schwebendes Fenster) mit Quelle je Modus: Mischer-Programm in Studio/Postproduction,
  Meeting-Programm in Meeting/Conference. Der Bridge-Fähigkeitsblock `live_program.meeting_preview` schaltet frei.

## Alternativen
- WebRTC in den Meeting-Helper kopieren: doppelter Codepfad, zwei Stellen für jeden Encoder-/ICE-Fehler.
- PGM-Helper liest den FrameBus des Meeting-Helpers: zwei Prozesse, zweiter Speicherweg, nur solange FrameBus
  für Meeting geschrieben wird.
- Chromium-WebRTC in der Bridge: RGBA-Rohbild durch V8, siehe ADR-0002.

## Folgen
- CPU-Kosten nur bei Zuschauern: ein Durchgang über das Bild (~1–2 ms je 1080p-Frame) plus asynchrone Hardware-
  Kodierung; der Pipeline-Thread wartet höchstens diese Zeit auf das Store-Lock. Messen mit `program.stream.status`
  (`dropped_frames`) im Gerätetest.
- Der Meeting-Helper linkt libdatachannel/OpenSSL statisch; Build braucht Homebrew `openssl@3` und Netz oder
  `FETCHCONTENT_SOURCE_DIR_LIBDATACHANNEL`. Windows meldet `program_stream_unavailable` bis Phase 2.
- ctest: `live-stream/tests` (Annex B, Leiter, VT-Smoke, WebRTC-Loopback) laufen in beiden Helper-Builds;
  `program_stream_rpc_test` prüft die RPC-Fläche mit dem Stub.
- `EncodeTarget` trägt seit ADR-0006 Encoder-Optionen (`h264Profile`, `prioritizeSpeed`, `hardRateLimit`); die Vorschau-
  Leiter `selectEncodeTarget` bleibt byte-identisch (Wächter in `bitrate_ladder_test`), `selectRecordingTarget` liefert
  das Archiv-Ziel der PGM-Aufnahme. Die Archiv-Policy liegt in `helper-common` (`recording_encode_policy.h`).
