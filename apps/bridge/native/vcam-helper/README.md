# broadify Virtual Camera Helper (macOS)

CoreMediaIO Camera Extension, die den MeetingHelper-Program-Output als
virtuelle Kamera ("broadify Camera") in Teams, Zoom, Google Meet und Browsern bereitstellt.

**Status: Scaffold.** Der Code ist vollständig angelegt, wird aber nicht automatisch
gebaut. Build, Signierung und Aktivierung erfolgen manuell (Apple Developer Account nötig).

## Architektur

```
meeting-helper (C++)             vcam-helper (dieses Verzeichnis)
  Program frame store ─RGBA8 stream▶  127.0.0.1:18787/stream.rgba
                                      │  RawFrameStreamReader (RGBA8 → BGRA8)
                                      ▼
                                  BroadifyVCamExtension (CMIOExtension)
                                    ▼
                                  Teams / Zoom / Meet / Browser
```

CMIO-Extensions sind sandboxed und können den POSIX-shm-FrameBus des GUI-Users
nicht direkt lesen. Die VCam nutzt deshalb einen lokalen Raw-Frame-Stream auf
`127.0.0.1` als Data-Plane zwischen MeetingHelper und Extension.

- `BroadifyVCamExtension/RawFrameStreamReader.swift` — persistenter Reader für
  `/stream.rgba`; puffert den neuesten Frame im Hintergrund und kopiert ihn pro
  CMIO-Tick in den PixelBuffer.
- `BroadifyVCamExtension/` — Camera Extension (Swift, `CMIOExtensionProvider`).
  Liest pro Frame-Tick den neuesten gepufferten Stream-Frame; ohne aktive Engine
  wird ein "No Signal"-Frame gesendet, damit die Kamera auswählbar bleibt.
- `BroadifyVCam/` — Container-App (SwiftUI-Stub), aktiviert/deaktiviert die
  System Extension über `OSSystemExtensionManager` und fordert die Aktivierung
  beim Start automatisch an.
- `project.yml` — [XcodeGen](https://github.com/yonaskolb/XcodeGen)-Definition.

Der VCam-Stream-Port ist `18787` (`MEETING_VCAM_FRAME_PORT` /
`DEFAULT_MEETING_VCAM_FRAME_PORT`).
Die WebApp-Preview nutzt den internen MJPEG-Preview-Store des Meeting-Helpers;
sie kann deshalb korrekt aussehen, auch wenn die aktive macOS-SystemExtension
noch eine alte Version nutzt oder den Raw-Frame-Stream nicht erreicht.

## Build

Voraussetzungen: Xcode 15+, XcodeGen (`brew install xcodegen`), Apple Developer Team.

```bash
# Team ID in project.yml pruefen/anpassen (DEVELOPMENT_TEAM)
npm run build:vcam-helper
```

Das Script erzeugt `apps/bridge/native/vcam-helper/build/Release/BroadifyVCam.app`.
Alternativ kann das Projekt mit `xcodegen generate` erzeugt und in Xcode gebaut werden.

## Signierung

Camera Extensions laufen nur signiert. Beide Targets benötigen:

1. **Team & Bundle-IDs:** `com.broadify.vcam` (App) und
   `com.broadify.vcam.extension` (Extension) im Developer-Portal registrieren.
   Die eingebettete Extension muss im App-Bundle als
   `Contents/Library/SystemExtensions/com.broadify.vcam.extension.systemextension`
   liegen (Dateiname = Bundle-ID).
2. **Capabilities:**
   - App: `System Extension` + App Sandbox
   - Extension: App Sandbox + `com.apple.security.network.client`
   - Extension Info.plist: `CMIOExtension` mit `CMIOExtensionMachServiceName`
     `$(TeamIdentifierPrefix)com.broadify.vcam.service`
3. **Provisioning:** Automatic Signing mit dem Team reicht für Entwicklung.
   Für Distribution außerhalb des App Store: Developer-ID-Zertifikat + Notarisierung
   (`xcrun notarytool submit … --wait`, danach `xcrun stapler staple`).
4. **Install-Flow:** Die installierte App nicht nachträglich mit einem anderen
   Team re-signieren. Das Install-Script kopiert den bereits korrekt signierten
   Xcode-Build unverändert nach `/Applications`.

Hinweis Entwicklung ohne Notarisierung: SIP-geschützte Systeme verlangen für
unsignierte/ad-hoc Extensions den Entwicklermodus:

```bash
systemextensionsctl developer on   # erfordert Neustart von SIP-Einstellungen ggf.
```

## Aktivierung

1. Gebaute `BroadifyVCam.app` nach `/Applications` kopieren (System Extensions
   werden nur aus `/Applications` aktiviert).
2. App starten. Der Aktivierungsdialog sollte automatisch erscheinen.
3. macOS-Dialog bestätigen, dann in **System Settings → General → Login Items & Extensions → Camera Extensions** `broadify Virtual Camera` aktivieren.
   Die Container-App kann diese Seite per Button **Open System Settings** direkt öffnen.
   Eine reine In-App-Freigabe ist von Apple für System Extensions nicht erlaubt.
4. Falls kein Dialog erscheint, auf "Activate extension" klicken.
5. Prüfen: `systemextensionsctl list` zeigt `com.broadify.vcam.extension` als
   `[activated enabled]`.
6. In Teams/Zoom/Meet als Kamera "broadify Camera" auswählen.

Deaktivieren: App → "Deactivate extension" oder
`systemextensionsctl uninstall <TeamID> com.broadify.vcam.extension`.

## End-to-End-Test mit der Meeting-Engine

1. Bridge starten; über die WebApp `meeting_engine_start` auslösen
   (Connections-Page → "Engine starten").
2. FrameBus-Output aktivieren: Relay-Command
   `meeting_output_configure` mit `target: "framebus"` und `action: "start"`.
3. Virtuelle Kamera starten: Relay-Command
   `meeting_output_configure` mit `target: "virtual_camera"` und `action: "start"`.
   Die Bridge oeffnet `BroadifyVCam.app`; die App fordert die Aktivierung beim
   Start automatisch an.
4. Kamera in einer Meeting-App auswählen — das komponierte Programmbild erscheint.
   Ohne laufende Engine zeigt die Kamera das "No Signal"-Muster.

Wenn nur das graue "No Signal"-Muster erscheint, zuerst den Raw-Stream und die
aktive Extension prüfen:

```bash
lsof -nP -iTCP:18787 -sTCP:LISTEN
/usr/bin/log show --last 5m --style compact --predicate 'subsystem == "com.broadify.vcam.extension"'
strings /Library/SystemExtensions/*/com.broadify.vcam.extension.systemextension/Contents/MacOS/BroadifyVCamExtension | grep raw-frame-stream
```

Die MeetingHelper-Logs müssen `meeting_vcam_raw` mit `event:"listening"` zeigen.
Die Extension-Logs müssen `Connected to raw VCam frame stream` und steigende
`Buffered raw VCam frame seq=...`-Meldungen zeigen. Fehlt der `strings`-Treffer,
läuft noch eine alte SystemExtension.

## Offene Punkte (bewusst nicht Teil des Scaffolds)

- Dynamische FPS/Format-Verhandlung (aktuell fix 30 fps, Größe folgt FrameBus-Header).
- Windows-Pendant (Media Foundation Virtual Camera, `MFCreateVirtualCamera`).
- Automatisierter Build/Release im electron-builder-Packaging der Bridge.
