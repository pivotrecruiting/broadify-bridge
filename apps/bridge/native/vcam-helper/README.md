# broadify Virtual Camera Helper (macOS)

CoreMediaIO Camera Extension, die den FrameBus (Shared Memory) der Meeting-Engine als
virtuelle Kamera ("broadify Camera") in Teams, Zoom, Google Meet und Browsern bereitstellt.

**Status: Scaffold.** Der Code ist vollständig angelegt, wird aber nicht automatisch
gebaut. Build, Signierung und Aktivierung erfolgen manuell (Apple Developer Account nötig).

## Architektur

```
meeting-helper (C++)             vcam-helper (dieses Verzeichnis)
  FrameBus writer  ───RGBA8──▶    FrameBus shm ("broadify-meeting")
                                    │  framebus_reader.c (RGBA8 → BGRA8)
                                    ▼
                                  BroadifyVCamExtension (CMIOExtension)
                                    ▼
                                  Teams / Zoom / Meet / Browser
```

- `Shared/` — C-Reader für das 128-Byte-FrameBus-Header-Layout
  (identisch zu `../framebus/include/framebus.h`, Magic `0x46475242`, Version 1).
- `BroadifyVCamExtension/` — Camera Extension (Swift, `CMIOExtensionProvider`).
  Liest pro Frame-Tick den neuesten FrameBus-Frame; ohne aktive FrameBus-Session
  wird ein "No Signal"-Frame gesendet, damit die Kamera auswählbar bleibt.
- `BroadifyVCam/` — Container-App (SwiftUI-Stub), aktiviert/deaktiviert die
  System Extension über `OSSystemExtensionManager` und fordert die Aktivierung
  beim Start automatisch an.
- `project.yml` — [XcodeGen](https://github.com/yonaskolb/XcodeGen)-Definition.

Der FrameBus-Segmentname ist `broadify-meeting-framebus` (`kFrameBusName` in
`VCamDeviceSource.swift`) und muss mit `BRIDGE_MEETING_FRAMEBUS_NAME` der Bridge
bzw. `MEETING_FRAMEBUS_NAME` des nativen `meeting-helper` übereinstimmen.

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
   - App: `System Extension` + App Sandbox + App Group `$(TeamIdentifierPrefix)com.broadify.vcam`
   - Extension: App Sandbox + App Group (gleicher Wert wie App)
   - Extension Info.plist: `CMIOExtension` mit `CMIOExtensionMachServiceName`
     `$(TeamIdentifierPrefix)com.broadify.vcam.service` (Kind der App Group)
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

## Offene Punkte (bewusst nicht Teil des Scaffolds)

- Dynamische FPS/Format-Verhandlung (aktuell fix 30 fps, Größe folgt FrameBus-Header).
- Windows-Pendant (Media Foundation Virtual Camera, `MFCreateVirtualCamera`).
- Automatisierter Build/Release im electron-builder-Packaging der Bridge.
