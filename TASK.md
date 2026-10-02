# Task: macOS Virtual Camera meldet fest 1920x1080 und Extension-Upgrades greifen beim Kunden (PR A)

## Raw request
Gabriel (Product Owner, 1.10.2026): "Plan, wie wir ein besseres Bild live (Teams/Zoom) bekommen und wie unsere Graphics wirklich in 1080p ausgespielt werden." Befund: Die macOS CMIO-Extension meldet Clients fest 1280x720 BGRA (live per AVFoundation-Enumeration bestätigt), liefert aber 1080p-Buffer. Außerdem läuft auf Gabriels Mac Extension-Build 17, obwohl App-Build 19 installiert ist: die Bridge aktiviert eine neuere Extension nie, solange die alte aktiv ist.

## Context
- Customer / project: Broadify Bridge, Meeting Mode, macOS
- Worktree / branch: /Users/gabrielbaeuerle/broadify-bridge-worktrees/vcam-1080p, feature/vcam-1080p
- Base branch: dev (573454e5)
- Entscheidung PO: VCam meldet NUR 1920x1080 (wie OBS), keine Formatliste.

## Plan
Siehe /Users/gabrielbaeuerle/.claude/plans/okay-dann-mache-bitte-linear-sunset.md, Abschnitt "WS1 (PR A)". Kurzfassung:

1. `apps/bridge/native/vcam-helper/BroadifyVCamExtension/VCamDeviceSource.swift`
   - Z. 7-9: `kDefaultWidth/Height` → `kOutputWidth = 1920`, `kOutputHeight = 1080` (Kommentar: fixed advertised format matching the meeting program geometry; no format list, like OBS).
   - `currentWidth/Height` (Z. 41-42) durch die Konstanten ersetzen; Splash (Z. 263-279) nutzt die Konstanten.
   - Den dynamischen Rebuild in `emitFrame` (Z. 162-169) ENTFERNEN. `rebuildVideoFormat` → `buildVideoFormat(width:height:)`, nur aus `init` (Z. 56) aufgerufen.
   - Aufruf Z. 191: `copyLatestFrame(into:stride:dstWidth:dstHeight:)` mit der Pool-Geometrie.
2. `apps/bridge/native/vcam-helper/BroadifyVCamExtension/RawFrameStreamReader.swift`
   - `import Accelerate`.
   - `copyLatestFrame(into dst: UnsafeMutablePointer<UInt8>, stride: Int, dstWidth: Int, dstHeight: Int) -> Bool`: Guard `stride >= dstWidth*4`; bei gleicher Geometrie Row-memcpy wie heute; sonst `vImageScale_ARGB8888` (`kvImageHighQualityResampling`, scale-to-fill) mit einmaligem `os_log(.info)` pro Geometriewechsel. Nie mehr als `dstHeight` Zeilen / `dstWidth*4` Bytes pro Zeile schreiben.
   - RGBA→BGRA-Schleife (Z. 237-249) durch `vImagePermuteChannels_ARGB8888` (Map `[2,1,0,3]`) ersetzen.
3. Version 19 → 20: `apps/bridge/native/vcam-helper/project.yml` (Z. 39 und Z. 73), `apps/bridge/native/vcam-helper/BroadifyVCam/Info.plist` (Z. 20), `apps/bridge/native/vcam-helper/BroadifyVCamExtension/Info.plist` (Z. 20). Alle drei Stellen müssen identisch sein (Vorbild-Commit 661fdad6).
4. `apps/bridge/src/modules/vcam/vcam-helper.ts`
   - `SystemExtensionActivationStateT` + `activeExtensionVersion: number | null`.
   - Exportierte Pure-Function `parseActiveVcamExtensionVersion(listOutput: string): number | null` (nur Zeilen mit `com.broadify.vcam.extension`; Regex `\(([^)]*)\)`; Build = letztes Segment nach `/`; `(1.0)` ohne Build → null; mehrere eigene Zeilen → höchste Version mit `enabled`). Vorbild: `scripts/install-vcam-helper-macos.sh:105-112`.
   - `getSystemExtensionActivationState` ZEILENWEISE auswerten (nicht `join`): während eines Replace stehen zwei eigene Zeilen (alt `[activated enabled]`, neu `[activated waiting for user]`); Regel: Zeile mit höchster Version bestimmt die Flags; `activeExtensionVersion` = höchste `enabled`-Version.
   - Exportierte Pure-Function `shouldReactivateVcamForUpgrade(installedAppVersion, activeExtensionVersion, autoUpgradeOnStart = process.env.BRIDGE_VCAM_AUTO_UPGRADE_ON_START !== "0"): boolean` → beide non-null und `installed > active`.
   - `openVcamHelperApp`: `already_active` nur, wenn kein Upgrade fällig (`shouldReactivateVcamForUpgrade(readBundleVersion(helperAppPath), activationState.activeExtensionVersion)`); sonst den bestehenden Launch-Pfad (`quitRunningVcamHelperApp()` + `open <app> --args --activate`) durchlaufen, Log "upgrading VCam extension build X -> Y"; höchstens EIN Upgrade-Versuch pro Bridge-Prozess (Modul-Flag), weil der Engine-Start das bei jedem Start anstößt.
   - `waitForVcamActivation(attempts, intervalMs, minVersion?)`: fertig bei `activated && (minVersion == null || activeExtensionVersion >= minVersion)` → `activation_completed` mit Message "…upgraded to build N"; sonst wie heute `activation_requested`.
   - `VcamHelperStatusT` + optionale Felder `helperAppVersion`, `extensionVersion` (Diagnose).
   - `ContentView.swift` NICHT ändern.
5. Doku: `docs/bridge/features/virtual-camera-macos.md` (Format 1920x1080 BGRA 30 fps = Programmgeometrie; Versionszeile `(1.0/20)`; Upgrade-Ablauf; mögliche erneute Freigabe), `docs/bridge/support/vcam-runbook.md` macOS-Abschnitt (Z. 146-156: ab Build 20 automatische Ersetzung beim Engine-Start, wenn Extension älter als App), `apps/bridge/native/vcam-helper/README.md` (Z. 26-31 veraltet, Z. 129 Format), `docs/bridge/dev/vcam-local-commands.md` (Z. 164-168 widersprüchlich → korrigieren).

Konventionen: Code-Kommentare Englisch; keine Secrets in Logs; keine weiteren Dateien anfassen; keine Builds von xcodebuild starten (macht der Verifier).

## Acceptance criteria
1. `VCamDeviceSource.swift` baut genau ein Stream-Format 1920x1080 BGRA 30 fps beim Init; kein dynamischer Rebuild mehr; Splash und Pool sind 1080p.
2. `RawFrameStreamReader.copyLatestFrame` kennt die Zielgröße, kann nie über den Zielpuffer hinaus schreiben und skaliert abweichende Frames per vImage.
3. CFBundleVersion ist an allen drei Stellen 20.
4. `vcam-helper.ts`: `parseActiveVcamExtensionVersion` und `shouldReactivateVcamForUpgrade` sind exportiert und getestet; `openVcamHelperApp` löst bei älterer aktiver Extension `open --args --activate` aus (einmal pro Prozess) und meldet nach erfolgreicher Ersetzung `activation_completed`; bei gleicher/neuerer Version weiterhin `already_active`.
5. `apps/bridge/src/modules/vcam/vcam-helper.test.ts`: bestehender "already active"-Test auf `(1.0/20)` + gemockte PlistBuddy-Ausgabe `"20"`; neue Tests: Upgrade-Reopen (`(1.0/17)` aktiv, App 20, zweiter Listenaufruf `(1.0/20)` → spawn `open [path, "--args", "--activate"]`, Code `activation_completed`), Parsing-Fälle (17, `(1.0)` → null, Fremdvendor ignoriert, zwei eigene Zeilen → höchste enabled), `shouldReactivateVcamForUpgrade`-Wahrheitstabelle inkl. Opt-out-Env, Status mit zwei eigenen Zeilen → `available: true`, `requiresUserApproval: false`, kein zweiter Upgrade-Versuch pro Prozess.
6. `npx jest apps/bridge/src/modules/vcam --runInBand` grün; `npm run lint` grün für die geänderten TS-Dateien.
7. Doku-Dateien aus Schritt 5 aktualisiert.

## Review
- Round: 1/3
- Verdict: PASS (Verifier 2.10.2026, separater Agent; alle 7 Akzeptanzkriterien PASS)
- Must-fix (open): keine
- Notes (non-blocking):
  1. Während eines laufenden Replace ("17 enabled" + "20 waiting for user") bestimmt die neueste Zeile die Flags → `activated=false`, `MEETING_VCAM_NATIVE_AVAILABLE=0`, Status `user_activation_required`, obwohl Build 17 weiter Frames liefert (Spec-konform; vorher ergab `requiresUserApproval` ebenfalls `user_activation_required`).
  2. Nach dem einen Upgrade-Versuch liefern weitere `openVcamHelperApp`-Aufrufe im selben Prozess `activation_requested` ("already requested") statt `already_active`; Webapp konsumiert die Codes nicht.
  3. Rückgabewert von `vImagePermuteChannels_ARGB8888` wird ignoriert (Pfad kalt, Server sendet BGRA); `vImageScale` alloziert Tempbuffer pro Frame (nur bei Quelle ≠ 1080p); Stretch-to-fill bei Nicht-16:9.
  4. `getVcamHelperStatus` startet pro Aufruf einen PlistBuddy-Prozess; `console.info` statt pino (Modul ohne Logger).
  5. Doku-Kleinigkeiten (Runbook "seit v20" vs. Schritte seit v19; Umlaut in ASCII-Dokument).
- Handoff to human (if any): Signierter Build lokal BLOCKED (keine "Apple Development"-Identität für PG38DC5RG9; nur Developer-ID-Zertifikat vorhanden) → CI baut mit `VCAM_SIGNING_MODE=developer-id`; unsignierter Compile BUILD SUCCEEDED, Version 20 in App + Extension verifiziert. Vorher/Nachher am Gerät erst mit RC-Installer.

## Verification
- [x] Tests pass — `npx jest apps/bridge/src/modules/vcam --runInBand`: 25 passed (Verifier)
- [x] Lint / type-check pass — `npm run lint` Exit 0; `tsc --noEmit -p apps/bridge/tsconfig.build.json` Exit 0 (Verifier)
- [x] `npm run build:vcam-helper` — mit `VCAM_SIGNING_MODE=developer-id` (wie CI) BUILD SUCCEEDED, codesign valid (Team PG38DC5RG9), CFBundleVersion 20 in App und Extension (Orchestrator); im Default-Modus "development" lokal BLOCKED (keine "Apple Development"-Identität)
- [ ] Bug reproduced before the fix, gone after (Enumeration 1280x720 → 1920x1080; Extension (1.0/17) → (1.0/20) nach Engine-Start) — RC-Feldtest
