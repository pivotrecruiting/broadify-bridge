# ADR-0002: Live-PGM läuft in einem eigenen nativen Helper-Prozess

- Status: akzeptiert
- Datum: 2026-10-24

## Kontext
broadifyStudio soll das Programmbild des Mischers live zeigen (UVC-Geräte wie ATEM Mini und RØDECaster Video,
später DeckLink-Eingänge), per WebRTC mit Hardware-H.264, auf macOS und Windows, bei minimaler CPU-Last.
Drei Orte kamen infrage:

1. Der bestehende Meeting-Helper (`apps/bridge/native/meeting-helper`): hat AVFoundation-/Media-Foundation-Capture,
   Recorder und Kontrollkanal, aber einen RGBA-only-Framevertrag, einen von der Programm-fps getriebenen Takt und
   linkt ONNX Runtime, OpenVINO und Metal (~200 MB RSS). Ein Encoder- oder WebRTC-Absturz würde Meeting reißen;
   der Neustart spielt Kamera-RPCs zurück, nicht PGM-Sessions.
2. Chromium im Electron-Renderer (MediaStreamTrackGenerator): 1080p60 müsste als RGBA (~500 MB/s) durch V8,
   der Encoder wäre Chromiums Wahl, ein verstecktes Renderer-Fenster käme dazu. Widerspricht „native Data Plane“.
3. Ein eigener Helper mit gemeinsamer statischer Bibliothek.

## Entscheidung
- Neuer Helper `apps/bridge/native/pgm-helper/` (C++17, CMake, ctest), eigener Prozess, eigener Kontrollkanal
  (JSON-RPC über Unix-Socket/Named Pipe wie der Meeting-Helper), auf macOS als signierte App-Bundle
  `com.broadify.bridge.pgm-helper` mit eigener Kamera-/Mikrofon-Zuordnung (TCC), auf Windows `pgm-helper.exe`.
- Gemeinsamer Code wird verhaltensgleich nach `apps/bridge/native/helper-common/` extrahiert (RPC-Transport,
  JSON-Utils, Event-Log, Options, FrameBus-C-Bibliothek, Geräte-Enumeration/Stable-Keys). Der Meeting-Helper
  linkt dieselbe Bibliothek.
- TS-seitig entsteht `apps/bridge/src/services/helpers/` (Start/Ready/Ping, Neustart-Policy, RPC-Client), an die
  `meeting-helper-manager`/`-client` delegieren. Phase 0 beginnt mit der reinen Neustart-Policy.
- Pixelformate bleiben nativ (NV12 von UVC, UYVY von DeckLink) bis zum Hardware-Encoder; kein RGBA-Umweg.
- Kein stiller Software-Encoder: fehlt Hardware-H.264, meldet der Helper `encoder_unavailable`.

## Alternativen
Siehe Kontext 1 und 2. Beide verworfen wegen CPU-Last, Crash-Isolation und Vertragsbruch (RGBA-only).

## Folgen
- Zwei Helper können dasselbe UVC-Gerät wollen; die Bridge arbitriert (`device_in_use`).
- Zweite signierte Helper-App, zweite Kamera-Abfrage, zusätzliche Einträge in Packaging- und Signierlisten.
- Der Phase-0-Refactor berührt den Meeting-Kritikpfad und wird als eigener, verhaltensgleicher PR geliefert.
- Die PGM-Aufnahme (ADR-0006) fährt einen zweiten Hardware-Encoder (H.264 High) im selben Helper; „kein stiller
  Software-Encoder“ gilt auch dort: fehlt der zweite Hardware-Slot, scheitert `pgm_recording_start` mit `encoder_unavailable`.
