# ADR-0004: libdatachannel als WebRTC-Stack des PGM-Helpers

- Status: akzeptiert
- Datum: 2026-10-24

## Kontext
Der PGM-Helper hat einen eigenen Hardware-Encoder und braucht nur Paketierung, ICE, DTLS-SRTP und RTCP-Feedback
(PLI/NACK) für eine 1:wenige-Verbindung Bridge → Browser. Der Relay transportiert nur kleine JSON-Nachrichten
und darf nie Medien führen.

## Entscheidung
- libdatachannel (MIT) mit libjuice (MIT), libsrtp (BSD), usrsctp (BSD) und MbedTLS (Apache-2.0), statisch per
  CMake FetchContent auf einen festen Commit gepinnt, `NO_WEBSOCKET/NO_EXAMPLES/NO_TESTS`, Offline-Override über
  `FETCHCONTENT_SOURCE_DIR_*`. Keine zusätzliche DLL/dylib, nur das Helper-Binary wird signiert.
- Ein PeerConnection je Zuschauer, Encoder einmal, Paketierung je Verbindung. Keyframe bei neuem Zuschauer und
  bei PLI (höchstens 1/s). Audio als Opus (libopus, BSD) im selben Zeitbezug.
- Signalisierung: Browser-Offer (recvonly) über den bestehenden signierten Befehlsweg, Antwort synchron,
  kein Trickle-ICE, keine neue Relay-Nachrichtenfamilie. TURN gemanagt (Cloudflare), Credentials kurzlebig je Seite.
- Lizenzen nach `NOTICES.md`.

## Alternativen
- libwebrtc: gn/ninja-Build, 20+ MB, eigener Encoder-Pfad, Prebuilts je Plattform. Unverhältnismäßig.
- WebRTC in Chromium (Electron): siehe ADR-0002.
- Medien durch den Relay: 2-MB-JSON-Frames, 512-MB-Maschinen, OOM-Historie. Ausgeschlossen.

## Folgen
- CI braucht Netz oder einen Spiegel für FetchContent.
- H.264 über OS-Encoder braucht keine eigene Codec-Lizenz; Chrome/Safari/Edge dekodieren H.264, Firefox über OpenH264.
