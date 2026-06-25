# VCam Local Commands

Diese Commands immer zeilenweise kopieren. Lange Pfade nicht manuell umbrechen.

## 1. In den VCam-Ordner wechseln

```bash
cd /Users/dennisschaible/Desktop/Coding/broadify-bridge/apps/bridge/native/vcam-helper
```

## 2. Xcode-Projekt generieren und oeffnen

```bash
xcodegen generate
```

```bash
open -a Xcode BroadifyVCam.xcodeproj
```

Falls `open -a Xcode` nicht funktioniert:

```bash
/Applications/Xcode.app/Contents/MacOS/Xcode BroadifyVCam.xcodeproj
```

## 3. Nach Xcode-Build: App automatisch finden

```bash
VCAM_APP=$(find "$HOME/Library/Developer/Xcode/DerivedData" -path "*/Build/Products/Debug/BroadifyVCam.app" -type d | tail -1)
```

```bash
echo "$VCAM_APP"
```

## 4. VCam-App nach Applications kopieren

```bash
cp -R "$VCAM_APP" "/Applications/BroadifyVCam.app"
```

## 5. VCam-App oeffnen

Wichtig: Immer nur die installierte Kopie unter `/Applications` starten.
Nicht aus Xcode DerivedData oder dem Repo-Build-Ordner oeffnen — macOS aktiviert
System Extensions aus dem Bundle der **laufenden** Parent-App.

```bash
open "/Applications/BroadifyVCam.app"
```

In der App auf `Activate extension` klicken.

Danach in macOS:

```text
System Settings -> General -> Login Items & Extensions -> Camera Extensions
```

Dort `broadify Virtual Camera` aktivieren. Die App oeffnet diese Seite nach dem
Systemdialog automatisch (Button: Open System Settings).

## 6. Aktivierung pruefen

```bash
systemextensionsctl list | grep broadify
```

## 7. Bridge mit VCam-Pfad starten

```bash
cd /Users/dennisschaible/Desktop/Coding/broadify-bridge
```

```bash
BRIDGE_VCAM_HELPER_PATH="/Applications/BroadifyVCam.app" npm run dev
```

## 8. Falls der Debug-Build nicht gefunden wird

Alle gefundenen Builds anzeigen:

```bash
find "$HOME/Library/Developer/Xcode/DerivedData" -name "BroadifyVCam.app" -type d
```

Wenn dort nur ein anderer Pfad erscheint, diesen Pfad nicht manuell umbrechen, sondern so setzen:

```bash
VCAM_APP="<HIER_DEN_GEFUNDENEN_PFAD_EINFUEGEN>"
```

Dann erneut:

```bash
cp -R "$VCAM_APP" "/Applications/BroadifyVCam.app"
```

```bash
open "/Applications/BroadifyVCam.app"
```

## 9. Raw-Frame-Stream pruefen (wenn nur Splash/no signal)

CMIO-Extensions sind sandboxed und lesen den MeetingHelper-Output ueber einen
lokalen Raw-Frame-Stream. Der MeetingHelper muss auf `127.0.0.1:18787`
lauschen:

```bash
lsof -nP -iTCP:18787 -sTCP:LISTEN
```

Die Bridge-Logs muessen `meeting_vcam_raw` mit `event:"listening"` zeigen.
Ohne laufenden MeetingHelper zeigt die Kamera den „No Signal“-Splash (graues
Bild mit hellem Rechteck).

Aktive Extension-Logs pruefen:

```bash
/usr/bin/log show --last 5m --style compact --predicate 'subsystem == "com.broadify.vcam.extension"'
```

Erwartet ist `Connected to raw VCam frame stream`. Wenn die WebApp-Preview
korrekt ist, aber die Kamera grau bleibt, ist der Program/Preview-Pfad meist
nicht das Problem. Dann laeuft sehr wahrscheinlich noch eine alte
Extension-Version oder die aktive Extension erreicht den lokalen Stream nicht.

## 10. Extension nach Rebuild ersetzen (wichtig)

macOS startet die Extension aus `/Library/SystemExtensions/`, nicht direkt aus
der `.app`. Nach jedem `install:vcam-helper` die neue Version aktivieren:

```bash
open "/Applications/BroadifyVCam.app"
```

In der App **Activate extension** klicken und ggf. die Ersetzung bestaetigen.
macOS ersetzt nur bei **neuer CFBundleVersion**. Vor einem Rebuild die Version
in diesen Dateien erhoehen, wenn bereits eine lokale Version installiert ist:

- `apps/bridge/native/vcam-helper/project.yml`
- `apps/bridge/native/vcam-helper/BroadifyVCam/Info.plist`
- `apps/bridge/native/vcam-helper/BroadifyVCamExtension/Info.plist`

Alternativ komplett deinstallieren und neu aktivieren:

```bash
systemextensionsctl uninstall PG38DC5RG9 com.broadify.vcam.extension
open "/Applications/BroadifyVCam.app"
```

Pruefen, ob die laufende Extension die Raw-Stream-Version enthaelt:

```bash
strings /Library/SystemExtensions/*/com.broadify.vcam.extension.systemextension/Contents/MacOS/BroadifyVCamExtension | grep raw-frame-stream
```

Wenn diese Zeile fehlt, laeuft noch die alte Extension.
Wenn mehrere Treffer aus unterschiedlichen `/Library/SystemExtensions/<UUID>/...`
kommen, in der App erneut **Activate extension** ausloesen und alte Versionen
ueber den offiziellen `systemextensionsctl uninstall`-Flow entfernen.
Diese Verzeichnisse nicht per `rm` loeschen; macOS besitzt und bereinigt
`/Library/SystemExtensions` nach Replacement/Uninstall, oft erst nach Reboot.

Der Production-Meeting-Start darf keine bestehende VCam-Installation automatisch
upgraden. Eine neue embedded Helper-Version wird zur Laufzeit nur mit
`BRIDGE_VCAM_AUTO_UPGRADE_ON_START=1` ueber eine vorhandene
`/Applications/BroadifyVCam.app` kopiert; normaler Meeting-Betrieb verwendet die
bereits aktivierte Camera Extension.

Im Dev-Flow installiert `npm run dev` die VCam nicht automatisch. Nach VCam-
Codeaenderungen oder wenn `/Applications/BroadifyVCam.app` fehlt:

```bash
npm run setup:vcam-helper
```

Danach `npm run dev` starten; der Dev-Start bricht ab, wenn
`verify:vcam-helper` die Kamera nicht als aktiv und in AVFoundation sichtbar
findet.
