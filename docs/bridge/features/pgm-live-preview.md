# Live-PGM-Vorschau (Studio)

Status: Phase 0 (Gerüst). Feature-Gate `BRIDGE_PGM_PREVIEW=1`, Web-App zusätzlich Entitlement `feature_live_program`.

## Ziel
Programmbild des Mischers (UVC: ATEM Mini, RØDECaster Video, Elgato; DeckLink-Eingänge) live in broadifyStudio,
per WebRTC mit Hardware-H.264 und Opus, kleinste Latenz, macOS und Windows. Entscheidungen: ADR-0002 bis 0004.

## Verträge
- Typen: `packages/protocol/src/index.ts` (`VideoSignalT`, `VideoInputDescriptorT`, `PgmStatusT`,
  `LiveProgramCapabilitiesT`), snake_case.
- Befehle (`apps/bridge/src/services/pgm/pgm-command-schemas.ts`): `pgm_get_status`, `pgm_inputs_list`,
  `pgm_source_select {input_id, profile?}`, `pgm_source_clear`, `pgm_session_list`,
  `pgm_webrtc_offer {session_id, sdp, viewer_user_id, ice_servers, label?}`, `pgm_webrtc_close {session_id, viewer_user_id}`.
- Fehlercodes: `apps/bridge/src/services/pgm/pgm-errors.ts`.
- Capability: `get_status.capabilities.live_program`.

## Stand je Phase
- Phase 0: Gate, Verträge, Befehlsgerüst, Neustart-Policy geteilt (fertig).
- Phase 1 (macOS, umgesetzt): nativer Helper `apps/bridge/native/pgm-helper` (UVC per AVFoundation in NV12,
  Formatwahl bis 1080p, Hot-Plug, Signalmessung aus echten Frames mit Snap auf Broadcast-Raten und 10 %-Hysterese,
  VideoToolbox-H.264 ohne B-Frames mit Keyframe auf PLI/neuen Zuschauer, gepaartes Audio als Opus 48 kHz/20 ms,
  libdatachannel-Publisher mit einer PeerConnection je Zuschauer), Bridge-Manager
  (`apps/bridge/src/services/pgm/pgm-helper-manager.ts`: Start bei Bedarf, Ready/Ping, Event-Log-Tail auf macOS,
  Neustart nach Absturz mit Re-Selektion, Sessions mit Zuschauergrenze, persistierte Quelle), Packaging als signierte
  App `Broadify Bridge PGM Helper.app`.
- Zuschauer-Sessions: Die Bridge reserviert je Offer einen Platz (Grenze `BRIDGE_PGM_MAX_VIEWERS`). Browser, die neu
  laden oder Strom verlieren, schicken kein `pgm_webrtc_close`; deshalb gibt die Bridge den Platz frei, sobald der
  Helper `pgm_viewer_state` mit `closed`/`failed` meldet, gleicht alle 10 s gegen `pgm.sessions.list` ab und fragt
  vor einer `pgm_viewer_limit`-Ablehnung noch einmal nach (der Helper räumt selbst: 10 s `disconnected`, 15 s nie
  verbunden). Ohne diesen Abgleich sperrte ein paar Mal Neuladen alle Zuschauer aus (Befund 2026-10-24).
- Meeting-Programm im selben Viewer (ADR-0005): Encoder, Annex B, Bitraten-Leiter und WebRTC-Publisher liegen in
  `apps/bridge/native/live-stream` (`broadify::live`), genutzt vom PGM-Helper und vom Meeting-Helper. Der Meeting-
  Helper streamt sein zusammengesetztes Kamerabild über `ProgramStream` (`src/live/program_stream.mm`): eigener
  Thread am `PreviewFrameStore`, ohne Zuschauer keine Kopie und kein Encoder, mit Zuschauern ein Durchgang
  RGBA→BGRA in einen gepoolten IOSurface-`CVPixelBuffer` und asynchrone VideoToolbox-Kodierung; die Frame-Pipeline
  (virtuelle Kamera, Aufnahme) wartet nie auf den Encoder. RPC `program.viewer.offer/close`,
  `program.sessions.list`, `program.stream.status`; Bridge-Befehle `meeting_program_offer/close/sessions/status`
  (gleiche Schemata wie `pgm_webrtc_*`, Mode-Gate Meeting, `bridges:view_program`, Sessions in
  `services/meeting/meeting-program-stream.ts` mit Grenze, Nutzerbindung und Abgleich). Fähigkeit
  `get_status.capabilities.live_program.meeting_preview`. Web: das schwebende Fenster wählt die Quelle je Modus
  (Studio/Postproduction → Mischer-PGM, Meeting/Conference → Meeting-Programm) und startet die Session beim
  Moduswechsel einmal neu. Windows: `program_stream_unavailable` bis zum Media-Foundation-Encoder (Phase 2).
- Quelle: `<userData>/pgm/pgm-source.json` wird beim Wählen/Entfernen geschrieben und beim Bridge-Start wieder
  gewählt (`restoreOnBoot`). Der Store entsteht erst beim ersten Zugriff, weil der Manager-Singleton vor dem
  Bridge-Kontext (userDataDir) importiert wird.
- Web: Das schwebende Fenster (`components/live-program/live-program-dock.tsx`, im App-Layout) ist der einzige
  Viewer: standardmäßig sichtbar, sobald der Nutzer das Live-Programm sehen darf und eine Bridge konfiguriert ist,
  per Navbar-Knopf ein-/ausblendbar, frei verschiebbar, Position je Browser gemerkt; Bridge-Probleme erscheinen als
  Overlay statt das Fenster abzubauen. Eine WebRTC-Verbindung je Browser, Freigabe erst 5 s nach dem letzten
  Konsumenten (Seitenwechsel, kurzes Schließen) und Berechtigungen einmal je Seitenladung gecacht. Die
  Signalcheck-Karte auf der Verbindungsseite wählt Eingang, Standbild und Aufnahme; natives Bild-im-Bild aus dem
  Fenster. Erster Durchlauf mit der eingebauten FaceTime-Kamera am 2026-10-24 erfolgreich.
- Aufnahme (vorgezogen aus Phase 6): MP4 ohne Neukodierung (VideoToolbox-Samples im Passthrough, Ton als AAC),
  startet am ersten Keyframe, `<datei>.mp4.part` bis zum sauberen Stopp, läuft unabhängig von Zuschauern.
  Befehle `pgm_recording_pick_path` (Speicherdialog auf dem Bridge-Rechner), `pgm_recording_start {file_path?}`
  (Standard `~/Movies/Broadify/Broadify-PGM-<zeit>.mp4`), `pgm_recording_stop`; Status in `pgm_status.recording`.
- Standbild: `pgm_snapshot {quality?}` liefert JPEG als Base64 (Relay-Grenze 2 MB beachtet), Download im Browser.
- Noch offen in Phase 1: Browser-Test mit echtem ATEM/RØDECaster (Ton, TURN von außerhalb), Latenzmessung.
- Phase 2: Windows UVC. Phase 3/4: DeckLink macOS/Windows. Phase 5: Ausbau. Phase 6: PGM-Aufzeichnung.

## Betrieb
- Standardmäßig an (der Helper startet erst bei Quelle oder Zuschauer); `BRIDGE_PGM_PREVIEW=0` ist der Notaus je Rechner, `BRIDGE_PGM_MAX_VIEWERS` (Standard 4, höchstens 16) begrenzt Zuschauer. Wer das Programm sehen darf, entscheidet die Web-App über `feature_live_program`; `capabilities.live_program.enabled` spiegelt den Notaus, `supported` die Bridge-Version.
- `BRIDGE_PGM_SYNTHETIC_SOURCE=1920x1080@60` startet den Helper mit Farbbalken und Bildzähler statt Gerät
  (Latenzmessung, Test ohne Mischer); `BRIDGE_LOG_PERF=1` liefert `pgm_perf` einmal je Sekunde.
- `BRIDGE_PGM_HELPER_PATH` überschreibt den Helper-Pfad (Dev-Builds).

## Helper-RPC (JSON-Zeilen über `helper-common`-Transport)
`control.ping`, `control.shutdown`, `pgm.inputs.list`, `pgm.source.select {input_id, profile}`, `pgm.source.clear`,
`pgm.status`, `pgm.sessions.list`, `pgm.perf.get`, `pgm.viewer.offer {viewer_id, sdp, profile, ice_servers[{url,username,credential}]}`
→ `{sdp}`, `pgm.viewer.close {viewer_id}`, `pgm.recording.start {file_path}`, `pgm.recording.stop`, `pgm.recording.status`,
`pgm.snapshot {quality}` → `{jpeg_base64,width,height,captured_at_ms}`. Ereignisse: `ready`, `pgm_status`, `pgm_signal`, `pgm_error`,
`pgm_encoder_configured`, `pgm_recording`, `pgm_inputs_changed`, `pgm_viewer_state`, `pgm_audio_unavailable`, `pgm_perf`, `shutdown`.

## Build
- `npm run build:pgm-helper` (macOS): CMake, libdatachannel v0.22.6 und libopus 1.5.2 per FetchContent (fester Tag),
  TLS statisch über Homebrew `openssl@3` (`brew install openssl@3`), Bundle signiert wie der Meeting-Helper.
  Offline: `FETCHCONTENT_SOURCE_DIR_LIBDATACHANNEL` / `FETCHCONTENT_SOURCE_DIR_OPUS` setzen.
- `SKIP_PGM_HELPER_BUILD=1` lässt Build und Artefakt-Prüfung aus (Windows-Builds, CI ohne Netz).
- Tests: `npm run test:pgm-helper-native` (ctest: Annex B, Bitratenleiter, Signalmessung, RPC-Dispatch, Transport,
  VideoToolbox-Smoke (überspringt ohne Hardware-Encoder), WebRTC-Loopback mit zwei Peers im Prozess).
- Medien laufen nie über den Relay; Signalisierung über den signierten Befehlsweg.
