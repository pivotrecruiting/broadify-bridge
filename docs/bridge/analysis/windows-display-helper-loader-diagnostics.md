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

## Release-Gate

Der RC bleibt blockiert, bis derselbe Installer auf dem Kunden-PC ohne `spawn UNKNOWN`
startet. Anschließend sind HDMI-Erkennung, drei Refreshes, Ab-/Anstecken, Mode-Liste,
1080p25 und 59.94/60-Ausgabe manuell zu prüfen. Auf macOS ARM64 bleiben drei
Erkennungen, Hotplug, Start-Stop-Start, Output-Wechsel und sichtbare Grafik erforderlich.
