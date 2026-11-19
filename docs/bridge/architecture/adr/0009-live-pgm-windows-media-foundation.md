# ADR-0009: Live-PGM unter Windows: Media-Foundation-Hardware-Encoder, OpenSSL statisch, WASAPI

- Status: akzeptiert (Umsetzung in Vorbereitung, hinter zwei Schaltern; nichts davon ist auf Windows-Hardware geprüft)
- Datum: 2026-11-19

## Kontext
Das Live-Programm (Mischer-PGM im Studio, Meeting-Programm im selben Viewer) läuft seit ADR-0002/0004/0005 nur auf
macOS: VideoToolbox-Encoder (`live-stream/src/vt_encoder.mm`), AVFoundation-Capture und -Audio im PGM-Helper,
`ProgramStream` im Meeting-Helper. Unter Windows meldet die Bridge `pgm_unsupported_bridge`
(`getLiveProgramCapabilities`: `supported = platform === "darwin"`), der Meeting-Helper linkt
`src/live/program_stream_stub.cpp` und antwortet `program_stream_unavailable`.

Die Windows-Fassung wird ohne Windows-Rechner vorbereitet: portable Refactorings werden auf macOS geprüft, Windows-
Quellen nur per Kompilieren und ctest auf einem GitHub-Runner (`windows-2022`). Ein solcher Runner hat keine GPU und
damit keinen Hardware-Encoder. Der erste echte Durchlauf findet in einer gemeinsamen Sitzung am Gerät statt
(Runbook: `docs/bridge/features/pgm-live-preview-windows.md`). Bis dahin darf nichts davon ein Windows-Release
verändern.

Mehrere Fragen berühren bestehende Doktrin und brauchen deshalb eine Entscheidung: Encoder-Wahl (ADR-0002: kein
stiller Software-Encoder), Pixelformate (ADR-0002: nativ bis zum Encoder), TLS-Backend (ADR-0004), Audio-Paarung und
Aufnahme (ADR-0006).

## Entscheidung

### 1. Encoder: nur Hardware-H.264-MFT
- Der Windows-Encoder (`live-stream/src/mf_encoder.cpp`) sucht ausschließlich über
  `MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER, MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER, …)` mit Ausgabetyp
  `MFVideoFormat_H264`. Findet sich kein Hardware-MFT oder lässt sich keiner konfigurieren, scheitert der Start
  sichtbar mit `encoder_unavailable`. Das gilt wie auf macOS für Vorschau und (später) Aufnahme.
- Der Microsoft-Software-MFT („H264 Encoder MFT“, `CLSID_CMSH264EncoderMFT`) ist **nur in Tests** zulässig (ctest auf
  dem GPU-losen CI-Runner, über eine interne Test-Naht des Encoders: der Test reicht den MFT selbst hinein, der
  Encoder-Quelltext kennt ihn nicht). Im Helper-Binary ist dieser Weg nicht erreichbar: weder über Umgebungsvariable
  noch über RPC.
- Die Auswahl- und Fehlerlogik (Reihenfolge der Kandidaten, Abbruchgründe) liegt in einem reinen Policy-Modul, das
  auf macOS mit einem Fake getestet wird.
- Der Name des gewählten MFT wird gemeldet (`EncoderInfo.name`, `--probe`), damit der Gerätetest die Hardware-Matrix
  belegen kann.

### 2. Eingabe: NV12 im Systemspeicher, kein D3D-Manager in v1
- v1 übergibt dem MFT `IMFMediaBuffer` im Systemspeicher (NV12). Kein `IMFDXGIDeviceManager`, keine D3D11-Texturen.
  Asynchrone Hardware-MFTs (`MF_TRANSFORM_ASYNC`) werden entsperrt und ereignisgetrieben bedient
  (`METransformNeedInput`/`METransformHaveOutput`).
- Grund: Der UVC-Pfad liefert ohnehin Systemspeicher, der Code bleibt ohne GPU-Gerät kompilier- und in Teilen
  testbar, und die Geräteverlust-Behandlung (`DXGI_ERROR_DEVICE_REMOVED`) entfällt. Der D3D-Pfad ist eine spätere
  Optimierung und bräuchte bei Einführung keine neue Doktrin-Entscheidung, solange Regel 1 gilt.

### 3. Farbumwandlung und Skalierung auf der CPU
- VideoToolbox skaliert und konvertiert selbst; ein H.264-MFT tut das nicht. Unter Windows wandeln deshalb reine
  Module in `live_stream_core` um: RGBA→NV12 (Meeting-Programm), YUY2/UYVY→NV12 (UVC, später DeckLink) und
  NV12-Skalierung auf das Ziel der Bitraten-Leiter (BT.709, Video-Range).
- Diese Module haben keine Plattform-Abhängigkeit, sind auf macOS per ctest geprüft und werden von Windows-Releases
  bereits heute mitkompiliert (`live_stream_core` ist Teil des Meeting-Helper-Builds). Sie müssen deshalb MSVC-sauber
  sein, auch solange die Schalter aus sind.
- ADR-0002 („Pixelformate bleiben nativ bis zum Encoder, kein RGBA-Umweg“) bleibt gewahrt: UVC- und DeckLink-Bilder
  gehen als YUV direkt nach NV12. RGBA entsteht nur dort, wo es die Quelle ist (Meeting-Compositor), wie auf macOS.

### 4. MJPG-Software-Dekodierung für UVC ist erlaubt
- Bietet ein UVC-Gerät seinen höchsten Modus (z. B. 1080p60) nur als MJPG an, darf der Windows-Capture-Pfad MJPG per
  Media Foundation dekodieren (Source Reader mit Videoverarbeitung bzw. MJPEG-Decoder-MFT) und NV12 liefern.
- Das ist keine Ausnahme von „kein Software-Encoder“: Die Regel betrifft die **Kodierung** des Streams. Bevorzugt
  bleibt ein unkomprimierter nativer Modus (NV12, YUY2, UYVY) gleicher Auflösung und Rate; MJPG wird nur gewählt,
  wenn sonst Auflösung oder Bildrate verloren ginge. Der gewählte Modus steht im Status und in `--probe`.

### 5. TLS: OpenSSL statisch, dasselbe Backend wie macOS
- libdatachannel linkt unter Windows OpenSSL statisch aus vcpkg (Triplet `x64-windows-static-md`: statische
  Bibliotheken, dynamische CRT wie die übrigen Helper). Keine zusätzliche DLL, keine zusätzliche Datei in den
  Signier- und VC-Runtime-Listen außer dem Helper-Binary selbst.
- Damit ist das TLS-Backend auf beiden Plattformen dasselbe. ADR-0004 nennt MbedTLS; der Code nutzt seit der
  Umsetzung OpenSSL (`live-stream/CMakeLists.txt`: `USE_MBEDTLS OFF`, Homebrew `openssl@3` statisch). Dieses ADR löst
  ADR-0004 in genau diesem Punkt ab; alles Übrige dort gilt weiter.
- OpenSSL 3 steht unter Apache-2.0, libdatachannel unter MPL-2.0; beide stehen in `NOTICES.md`.

### 6. Audio: WASAPI im Shared Mode, Paarung über Container-ID
- Der Ton des Mischers kommt über WASAPI-Capture im Shared Mode (ereignisgetrieben, Mix-Format des Geräts,
  Umwandlung auf 48 kHz Stereo für Opus). Kein Exclusive Mode: andere Programme dürfen das Gerät weiter nutzen.
- Paarung Video↔Audio: zuerst über die Container-ID (`DEVPKEY_Device_ContainerId`), die Video- und Audio-Funktion
  desselben USB-Geräts teilen; ersatzweise über den Namensvergleich wie auf macOS. Ohne Treffer läuft die Vorschau
  ohne Ton (`pgm_audio_unavailable`), nie mit dem Standard-Mikrofon.

### 7. Aufnahme unter Windows: später
- Der Windows-Helper bekommt einen Recorder-Stub; `pgm.recording.start` antwortet mit `recording_unsupported`, die
  Bridge meldet die Fähigkeit getrennt (`capabilities.live_program.recording`, unter Windows `false` und ohne
  `recording_profile`), damit die Web-App die Aufnahme-Bedienung unter Windows nicht anbietet.
- Die Aufnahme nach ADR-0006 (zweiter Hardware-Encoder, MP4-Passthrough) folgt nach dem Gerätetest in einem eigenen
  Schritt. Ob zwei parallele Hardware-Sessions auf allen Zielrechnern gehen, klärt die Sitzung am Gerät.

### 8. Zwei Schalter, beide standardmäßig aus
- **Build**: `BROADIFY_PGM_WINDOWS=1` nimmt die Windows-Targets (Encoder, WebRTC-Build mit vcpkg-OpenSSL,
  `pgm-helper.exe`, Meeting-`ProgramStream`) in den Build und `pgm-helper.exe` in Packaging-, Signier- und
  Artefaktlisten auf. Ohne den Schalter bleibt das Windows-Release bytegleich: neue Windows-Targets sind opt-in,
  weil `npm run test:meeting-helper-native` in `dist:win` alle Targets des Build-Verzeichnisses baut.
- **Laufzeit**: `BRIDGE_PGM_WINDOWS=1` lässt die Bridge unter Windows `live_program.supported` melden und den Helper
  starten. Ohne den Schalter verhält sich auch eine mit dem Build-Schalter gebaute Bridge wie heute
  (`pgm_unsupported_bridge`).
- Das Freischalten (Schalter-Standard ändern oder entfernen) ist eine eigene Entscheidung nach dem Gerätetest und
  bekommt ein eigenes ADR bzw. eine Statusänderung dieses ADR über ein Nachfolge-ADR.

## Alternativen
- **Software-Fallback (Microsoft-H.264-MFT, OpenH264, x264)** in der Auslieferung: bricht ADR-0002, 1080p60 auf der
  CPU neben Meeting-Keyer oder Studio-Renderer ist genau die Last, die das Feature vermeiden soll; x264 zusätzlich
  GPL. Verworfen; der Microsoft-MFT bleibt Testwerkzeug.
- **Hersteller-SDKs direkt (NVENC, AMF, oneVPL)**: drei Codepfade, drei SDK-Lizenzen und -Header, keine CI-Abdeckung.
  Die Hardware-MFTs der Treiber kapseln dieselben Encoder hinter einer Schnittstelle. Verworfen für v1.
- **D3D11-Eingabe ab v1**: spart eine Kopie, bringt Geräteverlust-Behandlung und einen nicht testbaren Pfad in die
  erste Fassung. Zurückgestellt.
- **Schannel oder MbedTLS als TLS-Backend**: libdatachannel kennt kein Schannel; MbedTLS wäre ein zweites Backend mit
  eigenem Fehlerbild (DTLS-Fingerprints, Cipher-Auswahl) nur für Windows. Verworfen zugunsten eines Backends.
- **OpenSSL als DLL**: zwei zusätzliche signierte Dateien, DLL-Suchpfad-Risiko. Verworfen.
- **Audio über Media Foundation Source Reader** statt WASAPI: weniger Kontrolle über Puffergröße und Zeitstempel,
  schlechtere Grundlage für Lippensynchronität. Verworfen.
- **Sink Writer mit eingebautem Encoder für die Aufnahme**: fällt wie AVAssetWriter still auf Software zurück
  (ADR-0006, Ansatz B). Nicht jetzt; die Aufnahme wird später wie auf macOS gebaut.

## Folgen
- Windows-CI (`windows-2022`) kompiliert und fährt ctest, kann aber keinen Hardware-Encoder prüfen: Der Encoder-
  Smoke-Test überspringt ohne Hardware-MFT, der Software-MFT deckt nur die Media-Foundation-Verdrahtung ab. „Grün im
  CI“ heißt ausdrücklich nicht „auf Hardware geprüft“.
- CPU-Kosten unter Windows liegen über denen auf macOS (Umwandlung und Skalierung auf der CPU, Kopie in den MFT).
  Zielwerte und Messung stehen im Runbook; reicht es nicht, ist der D3D-Pfad (Punkt 2) der nächste Schritt.
- Der Build mit `BROADIFY_PGM_WINDOWS=1` braucht vcpkg (auf den GitHub-Runnern vorhanden) und Netz für FetchContent,
  wie auf macOS.
- Treiberabhängigkeit: Hardware-MFTs unterscheiden sich je Hersteller (Low-Latency-Modus, Ratensteuerung,
  B-Frame-Verhalten, Zahl paralleler Sessions). Die Hardware-Matrix im Runbook ist Teil der Abnahme.
- Rechner ohne Hardware-H.264 (Server-SKUs, VMs, RDP-Sitzungen ohne GPU) zeigen `encoder_unavailable`. Das ist
  gewollt.
- Nur am Gerät prüfbar und deshalb offen: Hardware-Matrix NVIDIA/Intel/AMD/Hybrid-Laptop, zwei parallele Encoder-
  Sessions, UVC-Formate von ATEM Mini und RØDECaster Video, Audio-Paarung und Lippensynchronität, Firewall-Abfrage
  und ICE-Kandidaten, Latenz, Signatur/Smart App Control, Konsolenfenster und verwaiste Prozesse, Hochformat.
