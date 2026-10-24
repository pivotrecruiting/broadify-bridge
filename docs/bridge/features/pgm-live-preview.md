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
- Phase 0: Gate, Verträge, Befehlsgerüst (`pgm_disabled` / `pgm_not_implemented`), Neustart-Policy geteilt.
- Phase 1: macOS UVC → VideoToolbox → libdatachannel, Helper-App, Web-Kachel.
- Phase 2: Windows UVC. Phase 3/4: DeckLink macOS/Windows. Phase 5: Ausbau. Phase 6: PGM-Aufzeichnung.

## Betrieb
- `BRIDGE_PGM_PREVIEW=1` schaltet frei, `BRIDGE_PGM_MAX_VIEWERS` (Standard 4, höchstens 16) begrenzt Zuschauer.
- Medien laufen nie über den Relay; Signalisierung über den signierten Befehlsweg.
