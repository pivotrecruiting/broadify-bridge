# ADR-0003: FrameBus v2 als YUV-Capture-Ring für DeckLink-Eingänge

- Status: akzeptiert
- Datum: 2026-10-24

## Kontext
Das DeckLink-SDK bleibt laut Helper-Doktrin im `decklink-helper` (Crash-Isolation, CI ohne SDK). Der PGM-Helper
kodiert. Zwischen beiden müssen 1080p-Frames mit minimalen Kopien fließen. FrameBus (`apps/bridge/native/framebus`,
Shared Memory, Header v1 mit `pixel_format`-Feld und 72 Byte Reserve) ist die etablierte Data Plane, wird aber
nur mit RGBA8 und zwei Slots für die Grafik genutzt. AGENTS.md: „FrameBus als Data Plane“.

## Entscheidung
- FrameBus-Header v2 (`FRAMEBUS_VERSION 2`): neue Pixelformate UYVY und NV12, Felder `stride`, `fps_den`,
  `signal_flags`, `field_order` aus der Reserve, `capture_ns` je Slot, vier Slots, Sequenzprüfung nach dem Lesen.
  Busname `broadify-pgm-input-<id>`.
- Der N-API-Addon und die Grafik-Schicht bleiben RGBA-only und lehnen andere Formate explizit ab; die Grafik
  öffnet nie einen Capture-Bus. Die C-Bibliothek (Writer/Reader) wandert nach `helper-common`.
- Der PGM-Helper umhüllt Slot-Speicher ohne Kopie (`CVPixelBufferCreateWithBytes`), auf Windows eine Kopie in
  einen `IMFMediaBuffer`.

## Alternativen
- Eigener Ring neben FrameBus: zweite Data Plane, doppelte Heartbeat-/Layout-Logik. Verworfen.
- Frames über Pipe/Socket: Kopien und Syscalls je Frame. Verworfen.

## Folgen
- Header-Versionierung mit Layout-Test (ctest). Alte Leser erkennen v2 an der Version und lehnen ab.
- Dokumentation `graphics-realtime-framebus-c-header.md` bekommt den v2-Abschnitt.
