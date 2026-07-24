# Broadify auf Windows — vollständige Schritt-für-Schritt-Anleitung

Stand: 2026-07-11 · Branch `feature/conference-mode` · gegen den aktuellen Code verifiziert.

Diese Anleitung bringt **Meeting-Mode** auf Windows genauso zum Laufen wie auf dem Mac:
native Kamera, MODNet-Keyer und eine **virtuelle Kamera** für Teams/Zoom. Sie ist für
Gabriel geschrieben (klick-/kopierbar) und dient zugleich dem Entwickler als Referenz.

> **Wichtigste Regel vorweg:** Erst lesen, dann Schritt für Schritt. Kein Schritt
> überspringen. Bei Fehlern → Abschnitt **12. Troubleshooting**.

---

## 0. Was auf Windows läuft — und was (noch) nicht

**Läuft (verifiziert im Code, auf Win11 schon einmal live getestet):**
- Bridge (TypeScript) + Webapp — identisch zum Mac.
- **Kamera** nativ über MediaFoundation (`camera_mediafoundation.cpp`).
- **Keyer** über ONNX Runtime **DirectML** (GPU) mit CPU-Fallback (`modnet_keyer.cpp`).
- **Virtuelle Kamera** über `MFCreateVirtualCamera` (Win11) — „Broadify Camera" in Teams/Zoom.
- Compositor, Grafik-Bild-Decoder, MJPEG-Preview, Named-Pipe-Steuerung, Framebus.

**Conference-Mode — Ziel ist volle Mac-Parität (siehe Abschnitt 8.5):**
- ✅ Auto-Regie (Shure/Sennheiser), HDMI-Ausgang (display-helper), Compositor/PiP/Grafik,
  Keying-aus — portabel bzw. nur zu bauen.
- ❌ **Multi-Cam-Kamera-Capture muss noch implementiert werden** — MediaFoundation öffnet
  aktuell nur EINE Kamera; „mehrere Kameras live schalten + PiP" (der Conference-Kern)
  fehlt auf Windows und ist **echte Entwicklung**, kein reiner Build (Abschnitt 8.5 + 11).

**Läuft NOCH NICHT auf Windows (bewusste Lücken → Entwickler, Abschnitt 11):**
- **Meeting-Aufnahme** (MP4) — auf Windows ein Stub (nur macOS hat den Recorder).
- **Conference-Multi-Cam** — siehe oben (die zentrale Conference-Lücke).
- **Echter Grafik-Renderer** (Design-Hintergründe/Bauchbinden) — braucht einmalige
  Electron-Build-Einrichtung; solange `BRIDGE_GRAPHICS_RENDERER=stub` sind gerenderte
  Templates unsichtbar (hochgeladene Bilder/Logos gehen aber).
- **Call-Control** (Teams/Zoom-Shortcuts) — auf Windows noch nicht gebaut.

**Ehrlich zur Performance/Qualität:** Die Keyer-Qualität (MODNet + Guided-Filter) ist
dieselbe Familie wie auf dem Mac. Die **Geschwindigkeit hängt stark von der GPU ab**
(DirectML). Auf einer ordentlichen dedizierten GPU (NVIDIA/AMD/Intel Arc) wird es sehr
gut; auf schwacher integrierter Grafik kann der Keyer drosseln. Der Windows-Pfad nutzt
noch **nicht** die tief optimierte, fusionierte GPU-Pipeline vom Mac — „exakt gleich
schnell" ist ein Entwickler-Ziel (D3D-GPU-Compositing, Abschnitt 11). Mit den Hebeln in
**Abschnitt 10** holst du das Beste raus.

---

## 1. Systemvoraussetzungen (bitte zuerst prüfen)

| Punkt | Anforderung | Prüfen |
|---|---|---|
| **Windows-Version** | **Windows 11** x64 (jede Build-Nr.) | `Win + R` → `winver` |
| **GPU (Grundfunktion)** | DirectX-12-fähig (praktisch jede GPU ab ~2016) | `dxdiag` → Anzeige |
| **GPU (guter Keyer!)** | **stark**: dediziert (NVIDIA/AMD) oder Intel **Iris Xe / Arc**. Alte integrierte Grafik (z. B. Intel **UHD 620**) ist für Echtzeit-MODNet **zu schwach** → Keyer langsam/Passthrough | `dxdiag` |
| **RAM** | ≥ 8 GB (16 GB empfohlen) | — |
| **Festplatte** | ~5 GB frei für Code + Build | — |

> ⚠️ **Windows 10 geht NICHT** für die virtuelle Kamera — die API `MFCreateVirtualCamera`
> gibt es erst ab Windows 11. Auf Win10 läuft alles außer der virtuellen Kamera; für
> Teams/Zoom bräuchte es dann eine andere Strategie (Entwickler-Thema). **Bitte `winver`
> ausführen und mir die Version nennen, falls unsicher.**

---

## 2. Werkzeuge (du hast das meiste schon — hier die Vollständigkeitsprüfung)

Öffne **PowerShell** und prüfe jede Zeile (jede sollte eine Version ausgeben):

```powershell
git --version
node --version      # LTS: 20, 22 oder 24
npm --version
cmake --version     # oder von VS mitgeliefert (siehe unten)
```

Falls etwas fehlt:
1. **Git for Windows** — https://git-scm.com/download/win  *(bringt „Git Bash" mit — die brauchen wir für ein Modell-Skript!)*
2. **Node.js LTS** — https://nodejs.org
3. **Visual Studio 2022 Community** — https://visualstudio.microsoft.com
   - Installer → Workload **„Desktopentwicklung mit C++"** anhaken.
   - Rechts unter „Installationsdetails" sicherstellen: **Windows 11 SDK** (≥ 10.0.22621)
     und **C++-CMake-Tools für Windows**.
4. **Python 3** — https://python.org  *(nur als Fallback, falls `npm install` unten native
   Pakete selbst kompilieren muss; beim Installieren „Add to PATH" anhaken.)*

> **CMake-Tipp:** Wenn `cmake` in PowerShell nicht gefunden wird, öffne stattdessen die
> **„Developer PowerShell for VS 2022"** (Startmenü) — dort ist CMake + Compiler im PATH.
> **Alle Build-Schritte unten am besten in dieser Developer-PowerShell ausführen.**

---

## 3. Code auf den Windows-Rechner bringen (via Teams, als Git-Bundle)

Statt eines ZIPs (bei dem man `node_modules` etc. mühsam ausschließen müsste) kommt der
Code als **Git-Bundle** — je Repo **eine** Datei, die nur den echten Code enthält (kein
`node_modules`, keine Build-Reste), sauber klonbar. Auf dem Mac liegen sie in
`~/Desktop/broadify-windows-transfer/`:
- `broadify-bridge-<datum>.bundle`  (Bridge-Repo, ~120 MB)
- `broadify-<datum>.bundle`         (Webapp-Repo, ~10 MB)

**Beide Dateien per Teams** auf den Windows-Rechner schicken (z. B. nach
`C:\Users\<du>\Downloads\`). Dann in PowerShell **klonen** (kurze Pfade unter `C:\dev\`!):

```powershell
git clone "C:\Users\<du>\Downloads\broadify-bridge-<datum>.bundle" C:\dev\broadify-bridge
cd C:\dev\broadify-bridge
git checkout feature/conference-mode

git clone "C:\Users\<du>\Downloads\broadify-<datum>.bundle" C:\dev\broadify
cd C:\dev\broadify
git checkout feature/conference-mode
```

Was das Bundle **enthält** (getrackt): den kompletten Quellcode, die ORT+DirectML-DLLs
(`deps/onnxruntime/windows-x64`), alle `*.ps1` + `CMakeLists.txt`, die Anleitung.
Was **nicht** drin ist und separat/per Skript kommt:
- `node_modules` → Schritt 4 (`npm install`).
- `.env`-Dateien (Secrets) → Schritt 5 (getrennt, sicher).
- `modnet.onnx` (KI-Modell, 25 MB) → Schritt 6 (`npm run download:modnet-model`).

> Kurze Pfade wie `C:\dev\...` sind wichtig — Windows hat ein Pfadlängen-Limit.

---

## 4. Abhängigkeiten installieren (`npm install`)

**Drei** `npm install` nötig (die Bridge ist ein Monorepo, aber `apps/bridge` ist ein
**eigenständiges Paket ohne Workspace-Verknüpfung** und braucht ein separates Install):

```powershell
cd C:\dev\broadify-bridge
npm install

cd C:\dev\broadify-bridge\apps\bridge
npm install

cd C:\dev\broadify
npm install
```

> **Falls `npm install` im Bridge-Repo bei `node-hid` oder `@napi-rs/canvas` abbricht**
> (das sind die nativen Pakete fürs Stream Deck): Meist ziehen die fertige Windows-Builds.
> Wenn nicht, brauchen sie die VS-C++-Tools + Python (Schritt 2). Zur Not baust du erst
> ohne Stream Deck weiter — der Meeting-Mode braucht diese Pakete nicht zum Laufen.

---

## 5. Umgebungsdateien (`.env`)

Zwei Dateien mit Secrets, die **nicht** im ZIP sind. Leg sie an diese Stellen (Inhalte
kommen sicher von dir/dem Mac — Claude die Werte nie zeigen):

```
C:\dev\broadify\.env.local                       (Webapp)
C:\dev\broadify-bridge\apps\bridge\.env          (Bridge)
```

> In der Bridge-`.env` können **Mac-Pfade** stehen (z. B. `/Users/...`). Die auf Windows-
> Pfade (`C:\...`) anpassen bzw. weglassen — die kritischen sind `BRIDGE_ID` (Relay-
> Identität, **nie neu pairen**) und `BRIDGE_USER_DATA_DIR` (z. B. `C:\dev\broadify-bridge-data`).

---

## 6. KI-Modell holen (MODNet)

Der Windows-Keyer braucht `modnet.onnx` (nicht im Git, wird hash-verifiziert geladen).
**In „Git Bash"** (nicht PowerShell — das Skript ist ein Bash-Skript):

Das Skript braucht die Download-URL in der Umgebungsvariable **`MODNET_MODEL_URL`** (ist
sie nicht gesetzt, bricht es ab). Das Modell ist der **öffentliche Xenova-MODNet-ONNX-
Export** (Hugging Face `Xenova/modnet`); das Skript prüft danach die **SHA-256 gegen
`manifest.json`** (Soll: `07c308cf0fc7e6e8b2065a12ed7fc07e1de8febb7dc7839d7b7f15dd66584df9`)
— stimmt sie, ist das Modell verifiziert.

```bash
cd /c/dev/broadify-bridge
export MODNET_MODEL_URL="<URL zum Xenova-modnet-onnx-Export>"   # SHA muss zum Manifest passen
npm run download:modnet-model
```

Das lädt das Modell nach `apps/bridge/native/meeting-helper/models/modnet.onnx` und prüft
die SHA-256 gegen `manifest.json`. Danach kurz kontrollieren:
```powershell
dir C:\dev\broadify-bridge\apps\bridge\native\meeting-helper\models\
```
→ `modnet.onnx` **und** `manifest.json` müssen da sein.

---

## 7. Meeting-Helper bauen (`meeting-helper.exe`)

In der **Developer-PowerShell for VS 2022**:

```powershell
cd C:\dev\broadify-bridge\apps\bridge\native\meeting-helper
.\build.ps1
```

Das macht alles automatisch:
1. `cmake` konfiguriert + baut `meeting-helper.exe` (Release).
2. Kopiert die Exe nach `native\meeting-helper\meeting-helper.exe`.
3. Kopiert die Laufzeit-DLLs daneben: `onnxruntime.dll`, `onnxruntime_providers_shared.dll`,
   `DirectML.dll` (aus `deps\onnxruntime\windows-x64\lib`).

**Erfolg =** am Ende steht `Built …\meeting-helper.exe`. Kontrolle:
```powershell
dir C:\dev\broadify-bridge\apps\bridge\native\meeting-helper\*.exe
dir C:\dev\broadify-bridge\apps\bridge\native\meeting-helper\*.dll   # 3 DLLs
```

> Wenn die Exe „gelockt" ist (Neubau schlägt fehl): läuft noch eine alte Instanz — Bridge
> stoppen bzw. den Helfer per Named-Pipe `control.shutdown` beenden, dann neu bauen.

---

## 8. Virtuelle Kamera bauen + registrieren (nur Windows 11)

Die virtuelle Kamera ist eine DLL (`broadify-vcam.dll`), die Windows als Kamera anmeldet.

**8.1 Bauen** (Developer-PowerShell):
```powershell
cd C:\dev\broadify-bridge\apps\bridge\native\vcam-helper\windows
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release
```
→ erzeugt `build\Release\broadify-vcam.dll`.

**8.2 Registrieren** — PowerShell **als Administrator** (Rechtsklick → „Als Administrator"):
```powershell
cd C:\dev\broadify-bridge\apps\bridge\native\vcam-helper\windows
.\deploy-vcam.ps1 -SourceDll .\build\Release\broadify-vcam.dll
```
Das Skript kopiert die DLL nach `C:\dev\broadify-vcam\` und registriert sie (HKLM, `regsvr32 /s`).
Der Parameter `-SourceDll` ist **Pflicht** — er zeigt auf die eben gebaute DLL. Bei einem
Neubau-Zyklus deregistriert das Skript zuerst die alte (`regsvr32 /u`) und registriert neu.

**8.3 Prüfen:** Öffne die Windows-**Kamera-App**. Sobald der Meeting-Helfer läuft und ein
Programmbild produziert (Schritt 9–10), erscheint dort **„Broadify Camera"** mit Livebild.
Ohne laufenden Helfer ist die Kamera sichtbar, aber schwarz — das ist normal (kein
Frame-Server auf `127.0.0.1:18787`).

> Die virtuelle Kamera liest die Bilder über **Loopback-TCP** `127.0.0.1:18787` (BGRA mit
> „BFRG"-Header) vom Meeting-Helfer — genau wie auf dem Mac.

---

## 8.5 Conference-Mode auf Windows (für volle Mac-Parität)

Conference nutzt dieselbe Engine wie Meeting (Kamera + Grafik + Logo + PiP, Keying aus),
schaltet mehrere Kameras live und gibt das Programmbild als **HDMI-Vollbild** aus, plus
optional die **Auto-Regie** (Shure/Sennheiser). Für Windows-Parität:

**8.5.1 HDMI-Ausgang bauen (`display-helper`).** Der Ausgang nutzt **SDL2** — das muss auf
dem Rechner vorhanden sein. Falls der Build SDL2 nicht findet: die **SDL2 „VC-Devel"**-
Pakete (z. B. 2.32.x) von libsdl.org holen, z. B. nach `C:\SDL2` entpacken, und `SDL2.dll`
neben die fertige Exe legen. Dann:
```powershell
cd C:\dev\broadify-bridge\apps\bridge\native\display-helper
.\build.ps1
```
→ `display-helper.exe`. Das Skript legt die Exe am erwarteten Ort ab.

**8.5.2 Auto-Regie** (Array-Mikrofone Shure/Sennheiser) ist reines TypeScript
(`src/services/conference/director/…`, node net/dgram) → läuft auf Windows **ohne
Änderung**. Wichtig: der Array-Director braucht **kein** Kamera-Audio (er wertet die
Mikrofon-Signale übers Netz aus) → sobald das Umschalten funktioniert, arbeitet er sofort.

**8.5.3 Multi-Cam-Capture — IMPLEMENTIERT (auf Windows bauen + testen).**
Der Conference-Kern ist „mehrere Kameras gleichzeitig offen halten und live umschalten +
eine zweite als PiP". `camera_mediafoundation.cpp` überschreibt jetzt — **genau nach dem
Mac-Vertrag** (`camera_avfoundation.mm`) — `startSet` (öffnet alle Kameras, je ein
`MfCaptureSession`/Capture-Thread), `activeCameraSet`, `setProgramCamera` (schaltet nahtlos
ohne Neu-Öffnen um) und `copyLatestFrameFrom` (Bild einer bestimmten Kamera für PiP). Die
`MfCaptureSession`-Klasse (pro Kamera) war schon dafür ausgelegt und blieb unverändert.

> ⚠️ **Auf dem Mac nicht kompilierbar (Windows-only Code) — daher sorgfältig gegen die
> Mac-Referenz gebaut, aber auf deinem Windows-Rechner bauen + testen.** Test:
> Conference → Connections → mehrere Kameras öffnen → auf dem Stream Deck / in der Buttons-
> Seite zwischen Kameras umschalten (nahtlos, kein Neu-Öffnen) → PiP-Kamera einblenden.
> Wenn das läuft, ist der Conference-Kern auf Windows auf Mac-Niveau. Fehler → Terminal-
> Ausgabe des Helfers hierher kopieren.

---

## 9. Starten (Bridge + Webapp)

Zwei Terminals offen lassen.

**Terminal A — Bridge** (immer aus `apps/bridge`):
```powershell
cd C:\dev\broadify-bridge\apps\bridge
$env:BRIDGE_GRAPHICS_RENDERER="stub"   # bis der echte Renderer eingerichtet ist (Abschnitt 11)
npm run dev
```
→ Bridge läuft auf `:8787`, verbindet sich mit dem Relay (als deine Bridge-Identität).

**Terminal B — Webapp:**
```powershell
cd C:\dev\broadify
npm run dev
```
→ Webapp auf `http://localhost:3000`.

Im Browser die Webapp öffnen → sie sollte die Bridge als **verbunden** zeigen (dieselbe
`BRIDGE_ID` wie in der `.env`, nicht neu koppeln).

---

## 10. Testen + Performance auf Mac-Niveau bringen

**10.1 Grundfunktion (Meeting):**
1. Webapp → **Meeting → Connections** → Engine/Kamera starten.
2. Kamera erscheint, Keyer greift → im Vorschaubild bist du freigestellt.
3. **Virtuelle Kamera:** Windows-Kamera-App öffnen → „Broadify Camera" zeigt dein
   gekeytes Bild. Dann in **Teams/Zoom** unter Kamera „Broadify Camera" wählen.

**10.2 Performance-Hebel (Keyer flüssig + sauber):**
- **GPU nutzen:** DirectML läuft automatisch auf der GPU; kein Schalter nötig. Prüfe im
  Task-Manager (Leistung → GPU), dass beim Keying GPU-Last entsteht.
- **Auflösung/Qualität** wird über den Performance-Modus gesteuert (`high_quality`=512,
  `balanced`=320, `performance`=256). Standard ist `balanced`. Bei einer starken GPU
  kannst du auf `high_quality` gehen (schärfere Kante), bei schwacher auf `performance`.
- **Wichtig — Auflösungswechsel kosten:** DirectML kompiliert seine Kernel pro Auflösung
  neu (~mehrere Sekunden Kaltstart beim ersten Frame nach einem Wechsel). Nach einem
  Wechsel ein paar Sekunden warten, bis es sich einpegelt. Nicht ständig zwischen Modi
  springen.
- **Realistische Erwartung:** Auf guter GPU flüssig + scharf. Auf schwacher integrierter
  Grafik kann `mask_age` über das Limit steigen → der Keyer schaltet zum Schutz auf
  Passthrough (dein echter Hintergrund wird sichtbar). Dann `performance`-Modus nehmen
  oder eine bessere GPU. Die **volle Mac-Parität** (fusionierte GPU-Pipeline, Masken-
  Alter 0) ist ein Entwickler-Ausbau (Abschnitt 11).

---

## 11. Was für den Entwickler offen bleibt (damit Windows = Mac)

In Prioritätsreihenfolge:
1. **VCam-Kompatibilität härten:** aktuell liefert die virtuelle Kamera **RGB32**. Für
   maximale App-Kompatibilität **NV12 ergänzen** und **Zoom** gezielt testen (Zoom nutzt
   teils DirectShow-Legacy). Teams ist unkritisch.
2. **Conference-Multi-Cam:** MediaFoundation-Capture um `startSet` / `setProgramCamera` /
   `copyLatestFrameFrom` erweitern (mehrere Kameras gleichzeitig). **Danach läuft der
   Array-Director (Shure/Sennheiser) sofort** — der braucht kein Kamera-Audio.
3. **Echter Grafik-Renderer:** Offscreen-Chromium gegen die Electron-ABI bauen
   (`build:framebus` + Python/node-gyp), dann `BRIDGE_GRAPHICS_RENDERER` ≠ `stub`.
4. **Meeting-Aufnahme (MP4):** den nativen Recorder (macOS `AVAssetWriter`) auf Windows
   nachziehen (Media Foundation Sink Writer, H.264 + AAC).
5. **Call-Control:** Teams/Zoom-Shortcuts für Windows.
6. **GPU-Compositing (D3D):** für echte Mac-Parität bei Latenz/CPU — optional.
7. **Installer/Signing:** `npm run dist:win` (electron-builder, NSIS/MSI). Signing via
   **Azure Trusted Signing** (env-gated). Achtung: `dist:win` baut die **vcam.dll nicht
   mit** — die wird separat via `deploy-vcam.ps1` registriert.

---

## 12. Troubleshooting (dokumentierte Ursachen)

| Symptom | Ursache / Lösung |
|---|---|
| `cmake` nicht gefunden | **Developer PowerShell for VS 2022** benutzen (CMake + Compiler im PATH). |
| `npm run download:modnet-model` schlägt fehl | In **Git Bash** ausführen (Bash-Skript), nicht PowerShell. Internet nötig. |
| Helfer baut nicht neu / „locked" | Alte Instanz läuft → Bridge/Helfer beenden (`control.shutdown`), dann neu bauen. |
| „Broadify Camera" schwarz | Normal ohne laufenden Helfer. Erst Engine/Kamera in der Webapp starten. |
| „Broadify Camera" fehlt in Teams/Zoom | VCam nicht registriert (Schritt 8.2 als **Admin**) **oder** Windows 10 (nicht unterstützt). Zoom ggf. neu starten. |
| Kamera „list blockiert" / kein Bild | Alte Bug-Klasse (macOS-Permission-Gate) ist gefixt; sonst Kamera-Datenschutz in den Windows-Einstellungen für Desktop-Apps erlauben. |
| Keyer dauerhaft Passthrough | GPU zu schwach/gedrosselt → `performance`-Modus; Task-Manager-GPU-Last prüfen; nach Auflösungswechsel einpegeln lassen. |
| Grafiken/Bauchbinden unsichtbar | `BRIDGE_GRAPHICS_RENDERER=stub` → by design; echter Renderer = Abschnitt 11.3. Hochgeladene Bilder/Logos gehen trotzdem. |

---

## 13. Kurz-Referenz (die wichtigsten Befehle)

```powershell
# Einmalig pro Repo
cd C:\dev\broadify-bridge; npm install
cd C:\dev\broadify;        npm install

# Modell (Git Bash!)
cd /c/dev/broadify-bridge; npm run download:modnet-model

# Meeting-Helper bauen (Developer PowerShell)
cd C:\dev\broadify-bridge\apps\bridge\native\meeting-helper; .\build.ps1

# VCam bauen + registrieren (Admin-PowerShell)
cd C:\dev\broadify-bridge\apps\bridge\native\vcam-helper\windows
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release; cmake --build build --config Release
.\deploy-vcam.ps1 -SourceDll .\build\Release\broadify-vcam.dll

# Starten
cd C:\dev\broadify-bridge\apps\bridge; $env:BRIDGE_GRAPHICS_RENDERER="stub"; npm run dev   # Terminal A
cd C:\dev\broadify;                    npm run dev                                          # Terminal B
```

Bei Problemen: die Terminal-Ausgabe (Bridge + Helfer-stdout) ist die Wahrheitsquelle —
kopier sie mir, dann helfe ich gezielt weiter.
