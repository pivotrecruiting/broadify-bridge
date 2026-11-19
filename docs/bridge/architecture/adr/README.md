# Architecture Decision Records (ADR)

Entscheidungen, die eine bestehende Doktrin berühren (Prozessgrenzen, Data Plane, Drittbibliotheken), werden hier
festgehalten: ein Dokument je Entscheidung, nummeriert, nie umgeschrieben. Ersetzt eine neue Entscheidung eine alte,
bekommt die alte den Status „abgelöst durch ADR-NNNN“.

| ADR | Titel | Status |
|---|---|---|
| [0001](0001-adr-prozess.md) | ADR-Prozess | akzeptiert |
| [0002](0002-pgm-helper-eigener-prozess.md) | Live-PGM: eigener nativer Helper-Prozess | akzeptiert |
| [0003](0003-framebus-v2-yuv-capture-ring.md) | FrameBus v2 als YUV-Ring für DeckLink-Eingang | akzeptiert |
| [0004](0004-libdatachannel-fuer-pgm-webrtc.md) | libdatachannel als WebRTC-Stack des PGM-Helpers | akzeptiert |
| [0005](0005-live-stream-bibliothek-fuer-pgm-und-meeting.md) | Gemeinsame `live_stream`-Bibliothek für PGM- und Meeting-Helper | akzeptiert |
| [0006](0006-pgm-aufnahme-eigener-encoder.md) | PGM-Aufnahme mit eigenem H.264-High-Hardware-Encoder | akzeptiert |
