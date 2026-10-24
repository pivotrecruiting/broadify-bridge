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
- Noch offen in Phase 1: Browser-Test mit echtem ATEM/RØDECaster (Latenz, TURN), Signalcheck auf der Verbindungsseite.
- Phase 2: Windows UVC. Phase 3/4: DeckLink macOS/Windows. Phase 5: Ausbau. Phase 6: PGM-Aufzeichnung.

## Betrieb
- `BRIDGE_PGM_PREVIEW=1` schaltet frei, `BRIDGE_PGM_MAX_VIEWERS` (Standard 4, höchstens 16) begrenzt Zuschauer.
- `BRIDGE_PGM_SYNTHETIC_SOURCE=1920x1080@60` startet den Helper mit Farbbalken und Bildzähler statt Gerät
  (Latenzmessung, Test ohne Mischer); `BRIDGE_LOG_PERF=1` liefert `pgm_perf` einmal je Sekunde.
- `BRIDGE_PGM_HELPER_PATH` überschreibt den Helper-Pfad (Dev-Builds).

## Helper-RPC (JSON-Zeilen über `helper-common`-Transport)
`control.ping`, `control.shutdown`, `pgm.inputs.list`, `pgm.source.select {input_id, profile}`, `pgm.source.clear`,
`pgm.status`, `pgm.sessions.list`, `pgm.perf.get`, `pgm.viewer.offer {viewer_id, sdp, profile, ice_servers[{url,username,credential}]}`
→ `{sdp}`, `pgm.viewer.close {viewer_id}`. Ereignisse: `ready`, `pgm_status`, `pgm_signal`, `pgm_error`,
`pgm_encoder_configured`, `pgm_inputs_changed`, `pgm_viewer_state`, `pgm_audio_unavailable`, `pgm_perf`, `shutdown`.

## Build
- `npm run build:pgm-helper` (macOS): CMake, libdatachannel v0.22.6 und libopus 1.5.2 per FetchContent (fester Tag),
  TLS statisch über Homebrew `openssl@3` (`brew install openssl@3`), Bundle signiert wie der Meeting-Helper.
  Offline: `FETCHCONTENT_SOURCE_DIR_LIBDATACHANNEL` / `FETCHCONTENT_SOURCE_DIR_OPUS` setzen.
- `SKIP_PGM_HELPER_BUILD=1` lässt Build und Artefakt-Prüfung aus (Windows-Builds, CI ohne Netz).
- Tests: `npm run test:pgm-helper-native` (ctest: Annex B, Bitratenleiter, Signalmessung, RPC-Dispatch, Transport,
  VideoToolbox-Smoke (überspringt ohne Hardware-Encoder), WebRTC-Loopback mit zwei Peers im Prozess).
- Medien laufen nie über den Relay; Signalisierung über den signierten Befehlsweg.
