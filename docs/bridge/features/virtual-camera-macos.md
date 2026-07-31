# Virtuelle Kamera auf macOS (BroadifyVCam)

Endnutzer- und Support-Dokumentation für die macOS-Virtual-Camera. Entwickler-Details stehen in `apps/bridge/native/vcam-helper/README.md` und `docs/bridge/dev/vcam-local-commands.md`.

## Wie die Installation funktioniert

- `BroadifyVCam.app` wird **mit der Bridge ausgeliefert** (in den App-Ressourcen) und beim ersten Start der virtuellen Kamera automatisch nach `/Applications/BroadifyVCam.app` installiert.
- Der Installationspfad der Bridge entfernt dabei das Gatekeeper-Quarantäne-Attribut und repariert es auch bei Bestandsinstallationen selbst (Self-Heal beim Start der virtuellen Kamera).
- **Niemals** `BroadifyVCam.app` direkt aus einem DMG, dem Downloads-Ordner oder per „Paketinhalt zeigen" aus der Bridge-App starten. macOS führt quarantänierte Apps App-Transloziert aus einem zufälligen, schreibgeschützten Pfad aus — die Aktivierung der Kamera-Erweiterung schlägt dann immer fehl.
- Nach der Aktivierung muss die Erweiterung einmalig freigegeben werden: **Systemeinstellungen → Allgemein → Anmeldeobjekte & Erweiterungen → Kamera-Erweiterungen → broadify Virtual Camera**.

## Fehlercodes (Bridge-Status `meeting_output_configure` → `data.code`)

| Code | Bedeutung | Lösung |
| --- | --- | --- |
| `helper_app_not_in_applications` | App liegt/läuft nicht unter `/Applications` | App per Finder nach `/Applications` bewegen und von dort starten |
| `helper_app_quarantined` | Quarantäne-Attribut vorhanden → App-Translocation | Virtuelle Kamera erneut starten (Self-Heal); manuell: `xattr -dr com.apple.quarantine /Applications/BroadifyVCam.app` |
| `user_activation_required` | Erweiterung wartet auf Freigabe | In den Systemeinstellungen freigeben (siehe oben) |
| `reboot_required` | Alte Deinstallation hängt in macOS | Mac neu starten, dann erneut aktivieren |
| `helper_app_missing` / `helper_app_invalid` / `helper_app_install_failed` | Bundle fehlt/defekt/Installation fehlgeschlagen | App manuell nach `/Applications` kopieren und öffnen |
| `activation_requested` (Info) | App wurde geöffnet, Freigabe steht aus | Freigabe in den Systemeinstellungen erteilen |

Die Webapp zeigt diese Codes seit dem Translocation-Fix als verständliche Meldungen an (Toast an der Virtual-Camera-Karte bzw. Banner im Go-Live-Flow).

## Der klassische Fehlerfall (Screenshot „code=3")

`Extension request failed: App containing System Extension to be activated must be in /Applications folder. Current location: file:///var/folders/…/AppTranslocation/…` (`OSSystemExtensionErrorDomain code=3`)

Ursache: Die App wurde aus einer quarantänierten Quelle gestartet. Lösung: App schließen, sicherstellen, dass sie unter `/Applications` liegt, Quarantäne entfernen (oder virtuelle Kamera über die Bridge starten — Self-Heal), aus `/Applications` neu starten. Die App selbst zeigt seit v18 in diesem Zustand einen Hinweis mit „Show in Finder" statt des rohen Fehlertexts.

## Schnelldiagnose

```bash
xattr -p com.apple.quarantine /Applications/BroadifyVCam.app  # kein Output = sauber
systemextensionsctl list | grep com.broadify.vcam             # [activated enabled] = ok
```
