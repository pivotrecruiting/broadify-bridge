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
