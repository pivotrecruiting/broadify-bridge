# Windows Display Helper Loader Diagnostics

## Zweck

Dieses Runbook sichert die Daten, die einen Windows-Loaderfehler vor `main()` belegen
oder ausschließen. Es ist vor Promotion des nächsten RC einmal auf dem betroffenen
Kunden-PC auszuführen. Die erzeugten Dateien können lokale Pfade und Windows-Events
enthalten und müssen deshalb als Supportdaten vertraulich behandelt werden.

## Ausführung

PowerShell mit dem tatsächlich installierten NSIS-Pfad starten:

```powershell
$helper = "$env:LOCALAPPDATA\Programs\BroadifyBridgeRC\resources\native\display-helper\display-helper.exe"
.\scripts\collect-windows-display-helper-diagnostics.ps1 -HelperPath $helper
```

Das Script erfasst:

- Authenticode-Status, Signer, Dateigröße und SHA256 für `display-helper.exe`,
  `SDL2.dll` und `onnxruntime.dll`;
- direkten `--self-test`-Start inklusive Exit-Code;
- direkten `--list-displays`-Start mit der unveränderten `display_list`-Version 1;
- passende CodeIntegrity- und Defender-Events der letzten vier Stunden.

## Erwartetes Ergebnis

`--self-test` muss mit Exit-Code 0 exakt valides JSON mit `type: "self_test"`,
`version: 1` und `status: "ok"` liefern. Danach muss `--list-displays` ein valides
`display_list`-Payload der Version 1 liefern. Alle drei Binärartefakte müssen einen
gültigen Broadify-Signer und die erwarteten Release-Hashes besitzen.

## Exit-Code-Mapping in der Bridge

Seit `feature/display-detection-diagnostics` wertet die Bridge den Exit-Code von
`display-helper.exe --list-displays` selbst aus (`classifyWindowsHelperExitCode` in
`apps/bridge/src/modules/display/windows-display-helper.ts`). Node liefert den
Windows-Exit-Code als unsigned DWORD (z. B. `3221225781`); die Bridge normalisiert mit
`code >>> 0`, sodass auch eine vorzeichenbehaftete Darstellung (`-1073741515`) erkannt
wird.

| Exit-Code (dez.) | Hex | NTSTATUS | `kind` / `diagnostics.display.state` | Ursache |
| ---: | --- | --- | --- | --- |
| 3221225781 | 0xC0000135 | `STATUS_DLL_NOT_FOUND` | `missing_runtime` | Eine abhängige DLL fehlt – typischerweise `VCRUNTIME140.dll`/`MSVCP140.dll`, d. h. die Microsoft-Visual-C++-Runtime ist nicht installiert |
| 3221225785 | 0xC0000139 | `STATUS_ENTRYPOINT_NOT_FOUND` | `missing_runtime` | DLL vorhanden, aber zu alt (Export fehlt) – veraltete VC++-Runtime |
| 3221225794 | 0xC0000142 | `STATUS_DLL_INIT_FAILED` | `missing_runtime` | `DllMain` einer abhängigen DLL schlägt fehl |
| alle anderen ≠ 0 | – | – | `helper_failed` | Fehler nach Erreichen von `main()` (Enumeration, Ausgabe) |
| `null` (Signal) | – | – | `helper_failed` | Prozess durch Signal beendet |

Weitere Fehlerarten ohne Exit-Code: `spawn ENOENT` → `helper_missing` (Binary fehlt);
anderer Spawn-Fehler → `spawn_failed`; Timeout (2 s) → `timeout`; ungültige oder zu große
Antwort → `invalid_response` / `response_too_large`. Diese drei werden nach außen als
`helper_failed` gemeldet.

### Was die Bridge dann sichtbar macht

- **Log** (`bridge.log`, Level error):
  `[DisplayDetector] {"event":"windows_display_helper_failed","kind":"missing_runtime","exit_code":3221225781,"exit_code_hex":"0xC0000135","ntstatus":"STATUS_DLL_NOT_FOUND","stderr_excerpt":"…","helper_path":"<resources>/native/display-helper/display-helper.exe"}`.
  stderr wird bis 8 KiB gepuffert, der Auszug im Log auf 512 Zeichen gekürzt; der
  Helper-Pfad ist sanitisiert (kein Benutzername).
- **`/outputs` / `list_outputs`**: `diagnostics.display = { state: "missing_runtime",
  message: "Native display helper could not start (STATUS_DLL_NOT_FOUND). The Microsoft
  Visual C++ runtime is missing; install vc_redist.x64 or reinstall the bridge.",
  exitCode: 3221225781 }`.
- Die Module-Registry meldet weiterhin `detection_failed`; der Device-Cache behält den
  letzten gültigen Stand.

### Support-Hinweis

Bei `missing_runtime` zuerst die Visual-C++-Runtime installieren
(`vc_redist.x64.exe`, Microsoft „Latest supported Visual C++ Redistributable") und die
Bridge neu starten; alternativ Bridge neu installieren, sobald der Installer die
CRT-DLLs mitliefert. Danach `--self-test` wie oben beschrieben ausführen.

### Fix: CRT-DLLs neben den Helfern (Paket A-8)

Der Feldbefund vom 19.10. (Windows-Laptop ohne VC++-Redistributable:
`display-helper.exe` → `0xC0000135`, HDMI unsichtbar; `meeting-helper.exe`/`onnxruntime.dll`
gleiches Risiko) ist im Release-Build behoben: `dist:win` staged den vollständigen
`Microsoft.VC143.CRT`-Satz (`scripts/prepare-windows-vc-runtime.ps1`,
Liste in `scripts/lib/windows-vc-runtime.cjs`) und `electron-builder.config.cjs` packt
ihn nach `resources/native/display-helper/` **und** `resources/native/meeting-helper/`.
Damit ein CI-Runner mit installiertem Redistributable eine fehlende DLL trotzdem
erkennt, prüft `scripts/verify-windows-native-dependencies.cjs` (`dumpbin /DEPENDENTS`)
jede gepackte Helfer-Exe/-DLL gegen die System-DLL-Allowlist in
`scripts/lib/windows-native-dependency-policy.cjs` und die Dateien im selben Ordner.
Details: `docs/RELEASE_PROCESS.md` („MSVC-Runtime neben den Windows-Helfern"),
`docs/windows-build-guide.md` (Abschnitt 7.1), `docs/signing/windows-signing.md`.
Das Exit-Code-Mapping oben bleibt als Diagnose für ältere Installationen bestehen.

## Release-Gate

Der RC bleibt blockiert, bis derselbe Installer auf dem Kunden-PC ohne `spawn UNKNOWN`
startet. Anschließend sind HDMI-Erkennung, drei Refreshes, Ab-/Anstecken, Mode-Liste,
1080p25 und 59.94/60-Ausgabe manuell zu prüfen. Auf macOS ARM64 bleiben drei
Erkennungen, Hotplug, Start-Stop-Start, Output-Wechsel und sichtbare Grafik erforderlich.
